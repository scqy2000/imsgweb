import { invalidParams, requireMethods } from "./actions";
import { toApiMessage } from "./payloads";
import {
  rpc,
  RpcError,
  RpcErrorCode,
  type MessagePayload,
  type ScheduledMessagePayload,
} from "./rpc";

export class PaginationFallbackError extends RpcError {
  readonly pagination_fallback = true;
  constructor(detail: string) {
    super({
      code: RpcErrorCode.InvalidParams,
      message: "Pagination fallback required",
      data: detail,
    });
  }
}

// End is exclusive upstream. Include the cursor millisecond, then use ROWID
// to exclude the cursor/newer rows without dropping equal-timestamp siblings.
export async function timestampRowidPage(
  chat_id: number,
  limit: number,
  before: string,
  before_rowid: number,
) {
  const end = new Date(Date.parse(before) + 1).toISOString();
  for (
    let requested = Math.max(limit * 2, 100);
    ;
    requested = Math.min(5000, requested * 2)
  ) {
    const page = await rpc.call("messages.history", {
      chat_id,
      limit: requested,
      end,
      attachments: true,
      convert_attachments: true,
    });
    const eligible = page.messages
      .filter((m) => m.id < before_rowid)
      .sort((a, b) => b.id - a.id);
    if (eligible.length >= limit || page.messages.length < requested)
      return eligible.slice(0, limit);
    if (requested === 5000)
      throw new PaginationFallbackError(
        "timestamp boundary exceeds the 5000-row history budget",
      );
  }
}

// v0.17 exposes forward ROWID scans, not backwards history cursors. Keep only
// the newest requested matches while scanning, rather than retaining a database.
export async function scanNewest(
  limit: number,
  chat_id: number | undefined,
  before: number | undefined,
  matches: (message: MessagePayload) => boolean,
  attachments = false,
) {
  await requireMethods(["messages.after"]);
  // Start near the requested physical cursor, not at the database's beginning.
  // At most 10 x 500 visible rows are inspected per HTTP request. Sparse chats
  // that cannot fill a page in this window must use timestamp history instead.
  const start = before === undefined ? 0 : Math.max(0, before - 5001);
  let cursor = start;
  let rows: MessagePayload[] = [];
  for (let pages = 0; pages < 10; pages++) {
    const page = await rpc.call("messages.after", {
      since_rowid: cursor,
      chat_id,
      limit: 500,
      attachments,
      convert_attachments: attachments,
    });
    rows = [
      ...rows,
      ...page.messages.filter(
        (m) => (before === undefined || m.id < before) && matches(m),
      ),
    ]
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    if (!page.has_more || (before !== undefined && page.next_rowid >= before)) {
      if (rows.length < limit && start > 0)
        throw new PaginationFallbackError(
          "ROWID page exceeds the 5000-row scan window; use the timestamp before cursor",
        );
      return rows;
    }
    if (page.next_rowid <= cursor)
      invalidParams("RPC returned a non-advancing scan cursor");
    cursor = page.next_rowid;
  }
  throw new PaginationFallbackError(
    "ROWID page exceeds the 5000-row scan budget; use the timestamp before cursor",
  );
}

export async function searchMessages(
  query: string,
  chat_id: number | undefined,
  limit: number,
  before: number | undefined,
) {
  await requireMethods(["messages.search"]);
  // Never forward chat_id/before: upstream rejects those search keys.
  const result = await rpc.call("messages.search", { query, limit: 100 });
  // Keep upstream Unicode, attributed-body and audio-transcript matching intact.
  // No RPC chat filter/cursor exists; a saturated global result is explicitly
  // incomplete instead of inventing a local matching implementation.
  const truncated = result.messages.length === 100;
  const rows = result.messages.filter(
    (m) =>
      (chat_id === undefined || m.chat_id === chat_id) &&
      (before === undefined || m.id < before),
  );
  rows.sort((a, b) => b.id - a.id);
  return {
    messages: rows
      .slice(0, limit)
      .map((m) => toApiMessage({ ...m, attachments: [] })),
    next_before: rows.length > limit ? String(rows[limit - 1]!.id) : null,
    truncated,
    ...(truncated
      ? {
          warning:
            "imsg v0.17 search is limited to the newest 100 global matches; scoped and older results may be incomplete",
        }
      : {}),
  };
}

export function scheduledToApi(message: ScheduledMessagePayload) {
  return {
    ...toApiMessage({
      ...message,
      sender: "",
      is_from_me: true,
      created_at: message.scheduled_at,
      attachments: [],
      reactions: [],
      participants: [],
      is_group: message.chat_guid.includes(";+;"),
    }),
    ...message,
  };
}

export async function mapBounded<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const current = index++;
        if (current >= items.length) return;
        results[current] = await run(items[current]!);
      }
    }),
  );
  return results;
}
