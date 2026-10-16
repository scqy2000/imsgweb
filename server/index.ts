import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  ATTACHMENT_STORES,
  attachmentResponse,
  resolveAttachmentPath,
} from "./attachments";
import {
  AUTH_COOKIE,
  authToken,
  configuredPassword,
  passwordMatches,
  requireAuth,
} from "./auth";
import { toApiChat, toApiMessage } from "./payloads";
import {
  rpc,
  RpcError,
  RpcErrorCode,
  RpcExitError,
  WatchOverflowError,
} from "./rpc";
import {
  actionEnvelope,
  invalidParams,
  performAction,
  requireMethods,
} from "./actions";
import {
  mapBounded,
  PaginationFallbackError,
  scanNewest,
  scheduledToApi,
  searchMessages,
  timestampRowidPage,
} from "./reads";
import { parseUploadForm, sendMessage, withStagedUpload } from "./sends";

const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

const chatIdSchema = z.object({
  chatId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const optionalChat = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional();
const rowid = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const app = new Hono()
  .basePath("/api")
  .onError((error, c) => {
    if (error instanceof RpcError) {
      const status =
        error.code === RpcErrorCode.InvalidParams
          ? 400
          : error.code === RpcErrorCode.BridgeUnavailable ||
              error.code === RpcErrorCode.DatabaseUnavailable
            ? 503
            : 502;
      const mutation = c.req.method === "POST" && c.req.path !== "/api/auth";
      const certainty =
        typeof error.data === "object"
          ? error.data
          : mutation
            ? error.code === RpcErrorCode.InvalidParams ||
              error.code === RpcErrorCode.BridgeUnavailable ||
              error.code === RpcErrorCode.DatabaseUnavailable
              ? { retry_safe: true, disposition: "not_started" as const }
              : {
                  retry_safe: false,
                  disposition: "may_have_completed" as const,
                }
            : {};
      return c.json(
        {
          error: error.message,
          code: error.code,
          label: error.label,
          data: error.data,
          ...certainty,
          ...(error instanceof PaginationFallbackError
            ? { pagination_fallback: true }
            : {}),
        },
        status,
      );
    }
    if (error instanceof RpcExitError) {
      return c.json(
        {
          error: error.message,
          retry_safe: false,
          disposition: "may_have_completed",
          detail:
            "RPC process exited; any admitted mutation may have executed. Do not retry automatically.",
        },
        502,
      );
    }
    console.error(error);
    return c.json(
      {
        error: "internal error",
        ...(c.req.method === "POST" && c.req.path !== "/api/auth"
          ? {
              retry_safe: false,
              disposition: "may_have_completed",
              detail:
                "The server could not establish whether the mutation executed. Do not retry automatically.",
            }
          : {}),
      },
      500,
    );
  })
  .use(requireAuth)

  // Login: sets the auth cookie EventSource needs (it can't send headers).
  .post(
    "/auth",
    zValidator("json", z.object({ password: z.string() })),
    (c) => {
      const expected = configuredPassword();
      if (expected === undefined) return c.json({ ok: true as const });
      if (!passwordMatches(c.req.valid("json").password, expected)) {
        return c.json({ error: "wrong password" }, 401);
      }
      setCookie(c, AUTH_COOKIE, authToken(expected), {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
      return c.json({ ok: true as const });
    },
  )

  .get("/health", (c) => c.json({ status: "ok" as const }))

  .get("/status", async (c) => c.json(await rpc.call("status")))
  .get(
    "/search",
    zValidator(
      "query",
      z.object({
        query: z.string().trim().min(1).max(16384),
        chat_id: optionalChat,
        limit: z.coerce.number().int().min(1).max(100).default(50),
        before: rowid.optional(),
      }),
    ),
    async (c) => {
      const { query, chat_id, limit, before } = c.req.valid("query");
      return c.json(await searchMessages(query, chat_id, limit, before));
    },
  )
  .get(
    "/stats",
    zValidator("query", z.object({ chat_id: optionalChat })),
    async (c) => {
      await requireMethods(["messages.stats"]);
      return c.json(await rpc.call("messages.stats", c.req.valid("query")));
    },
  )
  .get(
    "/scheduled",
    zValidator(
      "query",
      z.object({
        chat_id: optionalChat,
        limit: z.coerce.number().int().min(1).max(5000).default(50),
      }),
    ),
    async (c) => {
      const { chat_id, limit } = c.req.valid("query");
      await requireMethods(["messages.scheduled"]);
      // Upstream has no chat filter or cursor; saturation must remain visible.
      const rpcLimit = chat_id === undefined ? limit : 5000;
      const result = await rpc.call("messages.scheduled", { limit: rpcLimit });
      return c.json({
        messages: result.messages
          .filter((m) => chat_id === undefined || m.chat_id === chat_id)
          .slice(0, limit)
          .map(scheduledToApi),
        truncated: result.messages.length === rpcLimit,
      });
    },
  )
  .get("/chats/:chatId/info", zValidator("param", chatIdSchema), async (c) => {
    await requireMethods(["chats.get"]);
    return c.json(
      await rpc.call("chats.get", { chat_id: c.req.valid("param").chatId }),
    );
  })
  .post("/actions", zValidator("json", actionEnvelope), async (c) =>
    c.json(await performAction(c.req.valid("json"))),
  )
  .post("/chats/:chatId/icon", zValidator("param", chatIdSchema), async (c) => {
    const data = z
      .object({
        file: z.instanceof(File).optional(),
        clear: z.enum(["true", "false"]).optional(),
        confirmed: z.enum(["true", "false"]).optional(),
      })
      .strict()
      .safeParse(parseUploadForm(await c.req.formData()));
    if (!data.success) invalidParams(data.error.message);
    const { file, clear, confirmed } = data.data;
    if ((file !== undefined) === (clear === "true"))
      invalidParams("provide file or clear=true, exclusively");
    if (clear === "true" && confirmed !== "true")
      invalidParams("explicit confirmation required to clear icon");
    if (file && !/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type))
      invalidParams("group icon must be an image upload");
    await requireMethods(["group.setIcon"]);
    return c.json(
      await withStagedUpload(file, (path) =>
        rpc.call("group.setIcon", {
          chat_id: c.req.valid("param").chatId,
          file: path,
        }),
      ),
    );
  })

  // Chat list, aggregated with a last-message preview per chat. The point
  // queries pipeline through the single rpc child (local SQLite) — cheap.
  .get(
    "/chats",
    zValidator(
      "query",
      z.object({
        limit: z.coerce.number().int().min(1).max(5000).default(50),
        unread_only: z
          .enum(["true", "false"])
          .transform((s) => s === "true")
          .default(false),
      }),
    ),
    async (c) => {
      const { limit, unread_only } = c.req.valid("query");
      await requireMethods(["chats.list", "messages.history"]);
      const { chats } = await rpc.call("chats.list", { limit, unread_only });
      const previews = await mapBounded(chats, (chat) =>
        // attachments give the preview a label when the text is
        // placeholder-only ("Image", "Sticker", …)
        rpc.call("messages.history", {
          chat_id: chat.id,
          limit: 1,
          attachments: true,
        }),
      );
      return c.json({
        chats: chats.map((chat, i) =>
          toApiChat(chat, previews[i]?.messages.at(-1)),
        ),
      });
    },
  )

  // Timestamp history retains its exclusive `end` bound. ROWID pagination
  // uses the separate, bounded forward-scan adapter, never a bogus RPC key.
  .get(
    "/chats/:chatId/messages",
    zValidator("param", chatIdSchema),
    zValidator(
      "query",
      z.object({
        limit: limitSchema,
        before: z.iso.datetime({ offset: true }).optional(),
        before_rowid: rowid.optional(),
      }),
    ),
    async (c) => {
      const { chatId } = c.req.valid("param");
      const { limit, before, before_rowid } = c.req.valid("query");
      await requireMethods(["messages.history"]);
      const { messages } =
        before_rowid !== undefined && before !== undefined
          ? {
              messages: await timestampRowidPage(
                chatId,
                limit,
                before,
                before_rowid,
              ),
            }
          : before_rowid !== undefined
            ? {
                messages: await scanNewest(
                  limit,
                  chatId,
                  before_rowid,
                  () => true,
                  true,
                ),
              }
            : await rpc.call("messages.history", {
                chat_id: chatId,
                limit,
                end: before,
                attachments: true,
                convert_attachments: true,
              });
      const ordered = [...messages].sort((a, b) => a.id - b.id);
      return c.json({
        messages: ordered.map(toApiMessage),
        next_before_rowid:
          messages.length === limit ? (ordered[0]?.id ?? null) : null,
        next_before:
          messages.length === limit ? (ordered[0]?.created_at ?? null) : null,
      });
    },
  )

  // Global SSE stream of new messages across all chats. The SSE event id is
  // the message rowid; EventSource's Last-Event-ID on reconnect becomes the
  // watch's since_rowid, so resume needs no server-side state.
  .get(
    "/events",
    zValidator(
      "query",
      z.object({ since: z.coerce.number().int().nonnegative().optional() }),
    ),
    (c) => {
      const header = c.req.header("last-event-id");
      const lastEventId =
        header !== undefined && /^\d+$/.test(header)
          ? Number(header)
          : undefined;
      const since =
        lastEventId !== undefined && Number.isSafeInteger(lastEventId)
          ? lastEventId
          : c.req.valid("query").since;
      return streamSSE(
        c,
        async (stream) => {
          // flush a first byte so the browser's EventSource fires `open`
          // immediately instead of waiting for the first event
          await stream.write(": connected\n\n");
          const watch = await rpc.watch({
            since_rowid: since,
            attachments: true,
            convert_attachments: true,
            include_reactions: true,
            buffer_limit: 256,
          });
          stream.onAbort(() => void watch.unsubscribe());
          const heartbeat = setInterval(
            () => void stream.write(": ping\n\n"),
            25_000,
          );
          try {
            for await (const message of watch) {
              await stream.writeSSE({
                event: "message",
                id: String(message.id),
                data: JSON.stringify(toApiMessage(message)),
              });
            }
          } catch (error) {
            if (error instanceof WatchOverflowError) {
              await stream.writeSSE({
                event: "watch.overflow",
                id: String(error.resume_after_rowid),
                data: JSON.stringify({
                  resume_after_rowid: error.resume_after_rowid,
                  terminal: true,
                  reason: error.reason,
                }),
              });
            } else {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  error:
                    error instanceof Error ? error.message : "watch failed",
                  ...(error instanceof RpcError
                    ? { code: error.code, data: error.data }
                    : {}),
                }),
              });
            }
          } finally {
            clearInterval(heartbeat);
            await watch.unsubscribe();
          }
        },
        // Watch death lands here; closing the stream makes EventSource
        // reconnect with Last-Event-ID and resume from its cursor.
        (error) => {
          console.error("sse stream error:", error);
          return Promise.resolve();
        },
      );
    },
  )

  // Send text and/or a file. Uploads are staged to a temp file only for the
  // lifetime of the request — imsg's send API takes a local path.
  .post("/messages", async (c) =>
    c.json(await sendMessage(await c.req.formData())),
  )

  // Delivery status point query — frontend polls this after a send.
  .get("/messages/:guid/status", async (c) =>
    c.json(
      await rpc.call("message.send_status", { guid: c.req.param("guid") }),
    ),
  )

  // Attachment bytes, browser-cacheable (immutable files + ETag/304/Range).
  // URLs are store-relative; see attachmentUrl in server/attachments.ts.
  .get(
    "/attachments/:store/:path{.+}",
    zValidator(
      "param",
      z.object({ store: z.enum(ATTACHMENT_STORES), path: z.string().min(1) }),
    ),
    async (c) => {
      const { store, path } = c.req.valid("param");
      const filePath = resolveAttachmentPath(store, path);
      if (filePath === null) {
        return c.json({ error: "not found" }, 404, {
          "cache-control": "no-store",
        });
      }
      return attachmentResponse(filePath, c.req.raw.headers);
    },
  );

export type AppType = typeof app;
export default app;
