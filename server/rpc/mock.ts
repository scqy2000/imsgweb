/**
 * Runnable stand-in for `imsg rpc`: NDJSON JSON-RPC 2.0 over stdio against
 * an in-memory fixture store, type-checked against ./types. Lets tests and
 * development run without the imsg binary or Full Disk Access:
 *
 *   IMSGWEB_RPC_CMD="bun server/rpc/mock.ts" bun run dev
 *
 * Behavior:
 * - chats.list, messages.history, watch.*, send, message.send_status with
 *   imsg's framing (id-less requests get no reply, errors carry `data`).
 * - watch.subscribe replays fixture rows with id > since_rowid, then live
 *   sends echo to matching subscriptions. `--interval <ms>` additionally
 *   emits a synthetic incoming message on the first chat every interval.
 * - Test triggers: subscribing to chat 999 ("Doomed") replays its rows and
 *   then kills the subscription with an error notification; sending the
 *   text "__crash__" exits 3 without responding.
 * - Exits 0 when stdin closes.
 */
import type {
  ChatPayload,
  MessagePayload,
  MessageSendStatusResult,
  RpcId,
  SendResult,
} from "./types";
import { RpcErrorCode } from "./types";
import { actionSchemas } from "../actions";
import { z } from "zod";

const DOOMED_CHAT_ID = 999;

function makeMessage(
  id: number,
  chat: ChatPayload,
  text: string,
  opts: { fromMe?: boolean; sender?: string; createdAt?: string } = {},
): MessagePayload {
  return {
    id,
    chat_id: chat.id,
    guid: `MOCK-${id}`,
    // real imsg reports the peer's handle even on is_from_me rows
    sender: opts.sender ?? chat.participants[0] ?? "",
    is_from_me: opts.fromMe ?? false,
    text,
    created_at: opts.createdAt ?? new Date().toISOString(),
    attachments: [],
    reactions: [],
    chat_identifier: chat.identifier,
    chat_guid: chat.guid,
    chat_name: chat.name,
    participants: chat.participants,
    is_group: chat.is_group,
  };
}

const chats: ChatPayload[] = [
  {
    id: 1,
    identifier: "+15551234567",
    guid: "iMessage;-;+15551234567",
    name: "Ada",
    service: "iMessage",
    last_message_at: "2026-06-10T00:00:02.000Z",
    participants: ["+15551234567"],
    is_group: false,
    contact_name: "Ada Lovelace",
    unread_count: 1,
  },
  {
    id: 2,
    identifier: "chat00000000000000000001",
    guid: "iMessage;+;chat00000000000000000001",
    name: "Pelican Crew",
    service: "iMessage",
    last_message_at: "2026-06-10T00:00:03.000Z",
    participants: ["+15551234567", "+15557654321"],
    is_group: true,
    unread_count: 2,
  },
  {
    // a 1:1 chat whose display_name is "" in chat.db and whose handle the
    // contact resolver can't match — name arrives empty (real imsg behavior)
    id: 3,
    identifier: "+15558675309",
    guid: "iMessage;-;+15558675309",
    name: "",
    service: "iMessage",
    last_message_at: "2026-06-10T00:00:04.000Z",
    participants: ["+15558675309"],
    is_group: false,
  },
  {
    id: DOOMED_CHAT_ID,
    identifier: "+15550009999",
    guid: "iMessage;-;+15550009999",
    name: "Doomed",
    service: "SMS",
    last_message_at: "2026-06-10T00:00:05.000Z",
    participants: ["+15550009999"],
    is_group: false,
  },
];

const chatById = (id: number | undefined): ChatPayload | undefined =>
  chats.find((chat) => chat.id === id);

const fixture = (id: number, chatId: number, text: string, fromMe = false) => {
  const chat = chatById(chatId);
  if (!chat) throw new Error(`fixture references unknown chat ${chatId}`);
  return makeMessage(id, chat, text, {
    fromMe,
    createdAt: `2026-06-10T00:00:0${id % 10}.000Z`,
  });
};

const messages: MessagePayload[] = [
  fixture(101, 1, "first"),
  fixture(102, 1, "second", true),
  fixture(103, 2, "hello group"),
  fixture(901, DOOMED_CHAT_ID, "doomed one"),
  fixture(902, DOOMED_CHAT_ID, "doomed two"),
];
messages[0]!.is_read = false;
if (process.argv.includes("--same-timestamp"))
  messages[0]!.created_at = messages[1]!.created_at;
messages[2]!.poll = {
  kind: "created",
  event: "imessage.poll.created",
  poll_guid: "MOCK-103",
  question: "Dinner?",
  options: [
    { id: "opt-1", text: "Pizza" },
    { id: "opt-2", text: "Sushi" },
  ],
};
messages[2]!.reactions = [
  {
    id: 105,
    type: "love",
    emoji: "",
    sender: "+15551234567",
    is_from_me: false,
    created_at: "2026-06-10T00:00:05.000Z",
  },
];
let nextRowid = 1000;

const subscriptions = new Map<number, { chatId: number | undefined }>();
let nextSubscription = 1;

interface MockRequest {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const write = (value: unknown) => console.log(JSON.stringify(value));

const reply = (id: RpcId | undefined, result: unknown) => {
  if (id !== undefined) write({ jsonrpc: "2.0", id, result });
};

const replyError = (
  id: RpcId | undefined,
  code: RpcErrorCode,
  message: string,
  data?: import("./types").RpcErrorObject["data"],
) => {
  if (id !== undefined)
    write({ jsonrpc: "2.0", id, error: { code, message, data } });
};

const num = (
  params: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
};

const str = (
  params: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
};

function notify(subscription: number, message: MessagePayload): void {
  write({
    jsonrpc: "2.0",
    method: "message",
    params: { subscription, message },
  });
}

/** Push a freshly stored message to every matching live subscription. */
function emit(message: MessagePayload): void {
  for (const [subscription, filter] of subscriptions) {
    if (filter.chatId === undefined || filter.chatId === message.chat_id) {
      notify(subscription, message);
    }
  }
}

function appendMessage(
  chat: ChatPayload,
  text: string,
  fromMe: boolean,
  parent?: MessagePayload,
  ownedGuid?: string,
): MessagePayload {
  const message = makeMessage(nextRowid++, chat, text, { fromMe });
  if (ownedGuid) message.guid = ownedGuid;
  if (parent) {
    message.reply_to_guid = parent.guid;
    message.thread_originator_guid =
      parent.thread_originator_guid ?? parent.guid;
    message.reply_to_text = parent.text;
    message.reply_to_sender = parent.sender;
  }
  messages.push(message);
  chat.last_message_at = message.created_at;
  emit(message);
  return message;
}

function resolveSendTarget(
  params: Record<string, unknown>,
): ChatPayload | null {
  const chatId = num(params, "chat_id");
  if (chatId !== undefined) return chatById(chatId) ?? null;
  const identifier = str(params, "chat_identifier");
  if (identifier !== undefined) {
    return chats.find((chat) => chat.identifier === identifier) ?? null;
  }
  const guid = str(params, "chat_guid");
  if (guid !== undefined)
    return chats.find((chat) => chat.guid === guid) ?? null;
  const to = str(params, "to");
  if (to !== undefined) {
    const existing = chats.find(
      (chat) =>
        chat.identifier === to ||
        (!chat.is_group && chat.participants.includes(to)),
    );
    if (existing) return existing;
    const chat: ChatPayload = {
      id: nextRowid++,
      identifier: to,
      guid: `iMessage;-;${to}`,
      name: to,
      service: "iMessage",
      last_message_at: new Date().toISOString(),
      participants: [to],
      is_group: false,
    };
    chats.push(chat);
    return chat;
  }
  return null;
}

function handle(request: MockRequest): void {
  const { id, method } = request;
  const params = request.params ?? {};
  const schema = schemas[method ?? ""];
  if (schema) {
    const checked = schema.safeParse(params);
    if (!checked.success) {
      replyError(
        id,
        RpcErrorCode.InvalidParams,
        "Invalid params",
        checked.error.message,
      );
      return;
    }
  }
  switch (method) {
    case "initialize":
    case "status": {
      reply(id, {
        version: "0.17.0",
        protocol_version: 1,
        database: {
          path: "/mock/chat.db",
          ready: true,
          features: {
            unread_state: true,
            scheduled_messages: true,
            reactions: true,
            reply_context: true,
            routing_metadata: true,
            balloon_payloads: true,
          },
        },
        bridge: {
          ready: true,
          bridge_version: 2,
          v2_ready: true,
          registry_available: true,
          selectors: {
            sendMessage: true,
            sendAttachment: true,
            urlPreviewMessage: true,
            sendRichLinkAction: true,
          },
        },
        contacts: { available: true },
        methods: Object.keys(schemas).filter((m) => !denied.has(m)),
        supported_methods: Object.keys(schemas),
      });
      return;
    }
    case "chats.get": {
      const chat = chatById(num(params, "chat_id"));
      if (!chat) {
        replyError(
          id,
          RpcErrorCode.InvalidParams,
          "Invalid params",
          `Chat not found: ${params["chat_id"]}`,
        );
        return;
      }
      const info = {
        id: chat.id,
        identifier: chat.identifier,
        guid: chat.guid,
        name: chat.name,
        service: chat.service,
        is_group: chat.is_group,
        participants: chat.participants,
      };
      reply(id, info);
      return;
    }
    case "messages.search": {
      const query = (str(params, "query") ?? "").toLowerCase();
      reply(id, {
        messages: messages
          .filter((m) =>
            params["match"] === "exact"
              ? m.text.toLowerCase() === query
              : m.text.toLowerCase().includes(query),
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, num(params, "limit") ?? 50)
          .map((m) => ({ ...m, attachments: [] })),
      });
      return;
    }
    case "messages.after": {
      const since = num(params, "since_rowid") ?? 0;
      const all = messages
        .filter(
          (m) =>
            m.id > since &&
            (params["chat_id"] === undefined ||
              m.chat_id === params["chat_id"]),
        )
        .sort((a, b) => a.id - b.id);
      const rows = all.slice(0, num(params, "limit") ?? 100);
      reply(id, {
        messages: rows,
        next_rowid: rows.at(-1)?.id ?? since,
        has_more: rows.length < all.length,
      });
      return;
    }
    case "messages.scheduled": {
      reply(id, {
        messages: [
          {
            id: 800,
            guid: "SCHEDULED-800",
            chat_id: 1,
            chat_identifier: chats[0]!.identifier,
            chat_guid: chats[0]!.guid,
            chat_name: "Ada",
            text: "Tomorrow",
            service: "iMessage",
            scheduled_at: "2099-01-01T12:00:00.000Z",
            schedule_type: 1,
            schedule_state: 1,
          },
        ].slice(0, num(params, "limit") ?? 50),
      });
      return;
    }
    case "messages.stats": {
      const chatId = num(params, "chat_id");
      if (chatId !== undefined && !chatById(chatId)) {
        replyError(
          id,
          RpcErrorCode.InvalidParams,
          "Invalid params",
          "unknown chat_id",
        );
        return;
      }
      const rows = messages.filter(
        (m) => chatId === undefined || m.chat_id === chatId,
      );
      reply(id, {
        total_messages: rows.length,
        sent_messages: rows.filter((m) => m.is_from_me).length,
        received_messages: rows.filter((m) => !m.is_from_me).length,
        time_zone: str(params, "time_zone") ?? "UTC",
        chats: [],
        senders: [],
        services: [],
        dates: [],
        ...(params["include_media"] ? { media: { total_attachments: 0 } } : {}),
      });
      return;
    }
    case "chats.list": {
      const limit = num(params, "limit") ?? 20;
      const sorted = chats
        .filter(
          (chat) => !params["unread_only"] || (chat.unread_count ?? 0) > 0,
        )
        .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      reply(id, { chats: sorted.slice(0, Math.max(1, limit)) });
      return;
    }

    case "messages.history": {
      const chat = chatById(num(params, "chat_id"));
      if (!chat) {
        replyError(
          id,
          RpcErrorCode.InvalidParams,
          "Invalid params",
          "unknown chat_id",
        );
        return;
      }
      const limit = num(params, "limit") ?? 50;
      const end = str(params, "end");
      // faithful to imsg: newest-first response, `end` bound is exclusive
      const rows = messages
        .filter(
          (m) =>
            m.chat_id === chat.id && (end === undefined || m.created_at < end),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      reply(id, { messages: rows });
      return;
    }

    case "watch.subscribe": {
      const chatId = num(params, "chat_id");
      const sinceRowid = num(params, "since_rowid");
      const subscription = nextSubscription++;
      const doomed = chatId === DOOMED_CHAT_ID;
      if (!doomed) subscriptions.set(subscription, { chatId });
      reply(id, { subscription });
      if (sinceRowid !== undefined && sinceRowid !== 0) {
        for (const message of messages) {
          if (
            message.id > sinceRowid &&
            (chatId === undefined || message.chat_id === chatId)
          ) {
            notify(subscription, message);
          }
        }
      }
      if (doomed) {
        write({
          jsonrpc: "2.0",
          method: "error",
          params: { subscription, error: { message: "stream died" } },
        });
      }
      if (process.argv.includes("--overflow")) {
        subscriptions.delete(subscription);
        write({
          jsonrpc: "2.0",
          method: "watch.overflow",
          params: {
            subscription,
            resume_after_rowid: 102,
            reason: "buffer_limit_exceeded",
            terminal: true,
          },
        });
      }
      return;
    }

    case "watch.unsubscribe": {
      subscriptions.delete(num(params, "subscription") ?? -1);
      reply(id, { ok: true });
      return;
    }

    case "send":
    case "send.tracked":
    case "send.rich":
    case "send.attachment":
    case "send.sticker":
    case "send.multipart": {
      const text = str(params, "text") ?? "";
      const attempt =
        method === "send.tracked"
          ? str(params, "attempt_id")!.toLowerCase()
          : undefined;
      if (attempt && messages.some((m) => m.guid.toLowerCase() === attempt)) {
        replyError(
          id,
          RpcErrorCode.InvalidParams,
          "Invalid params",
          "attempt_id already identifies a message",
        );
        return;
      }
      if (text === "__crash__") process.exit(3);
      if (text === "__internal__") {
        replyError(
          id,
          RpcErrorCode.InternalError,
          "Internal error",
          "untyped transport failure",
        );
        return;
      }
      if (text === "__unsafe__" || text === "__inflight__") {
        replyError(
          id,
          text === "__inflight__"
            ? RpcErrorCode.MutationBlocked
            : RpcErrorCode.DeliveryUnknown,
          "Delivery outcome unknown",
          {
            retry_safe: false,
            disposition:
              text === "__inflight__"
                ? "still_in_flight"
                : "may_have_completed",
            transport: "bridge_v2",
            operation: "sendMessage",
            detail: "mock delivery cannot be proved",
          },
        );
        return;
      }
      const chat = resolveSendTarget(params);
      if (!chat) {
        replyError(
          id,
          RpcErrorCode.InvalidParams,
          "Invalid params",
          "unknown chat_id",
        );
        return;
      }
      const body =
        method === "send.multipart"
          ? (params["parts"] as { text: string }[])
              .map((p) => p.text)
              .join("\n")
          : (str(params, "url") ?? text);
      const replyTo = str(params, "reply_to")?.replace(/^p:\d+\//, "");
      const parent =
        replyTo === undefined
          ? undefined
          : messages.find((m) => m.guid === replyTo && m.chat_id === chat.id);
      if (replyTo !== undefined && !parent) {
        replyError(
          id,
          RpcErrorCode.InvalidParams,
          "Invalid params",
          "unknown reply target",
        );
        return;
      }
      const message = appendMessage(chat, body, true, parent, attempt);
      const result: SendResult = {
        ok: true,
        ...(attempt ? { attempt_id: attempt } : {}),
        transport:
          method === "send" && params["transport"] !== "bridge"
            ? "applescript"
            : "bridge",
        id: message.id,
        guid: message.guid,
        message_id: message.guid,
        chat_guid: chat.guid,
        service: chat.service,
        ...(method === "send.multipart"
          ? { parts_count: (params["parts"] as unknown[]).length }
          : {}),
        ...(method === "send.sticker"
          ? { transfer_guid: `TRANSFER-${message.id}` }
          : {}),
      };
      reply(id, result);
      return;
    }

    case "message.send_status": {
      const guid = str(params, "guid") ?? "";
      const sent = messages.find((m) => m.guid === guid && m.is_from_me);
      const checkedAt = new Date().toISOString();
      const result: MessageSendStatusResult = sent
        ? {
            ok: true,
            guid,
            send_state: "delivered",
            service: "iMessage",
            checked_at: checkedAt,
            delivered_at: sent.created_at,
            status_fields: {
              is_sent: true,
              is_delivered: true,
              is_finished: true,
              error: 0,
              date_delivered: sent.created_at,
              date_read: null,
              is_delayed: false,
              is_prepared: false,
              is_pending_satellite_send: false,
              was_downgraded: false,
            },
          }
        : {
            ok: true,
            guid,
            send_state: "pending",
            service: null,
            checked_at: checkedAt,
            status_fields: null,
          };
      reply(id, result);
      return;
    }

    default:
      if (method && Object.hasOwn(actionSchemas, method)) {
        if (method === "handles.check") {
          reply(id, {
            ok: true,
            address: params["address"],
            alias_type:
              str(params, "alias_type") ??
              (String(params["address"]).includes("@") ? "email" : "phone"),
            service: "iMessage",
            available: true,
          });
          return;
        }
        if (method === "chats.create") {
          const row = nextRowid++;
          const chat: ChatPayload = {
            id: row,
            identifier: `chat${row}`,
            guid: `iMessage;+;chat${row}`,
            name: str(params, "name") ?? "",
            service: "iMessage",
            last_message_at: new Date().toISOString(),
            participants: params["addresses"] as string[],
            is_group: true,
            unread_count: 0,
          };
          chats.push(chat);
          if (params["text"]) appendMessage(chat, String(params["text"]), true);
          reply(id, { ok: true, chat_guid: chat.guid, service: "iMessage" });
          return;
        }
        const chat = resolveSendTarget(params);
        if (!chat) {
          replyError(
            id,
            RpcErrorCode.InvalidParams,
            "Invalid params",
            "unknown chat_id",
          );
          return;
        }
        if (method.startsWith("group.") && !chat.is_group) {
          replyError(
            id,
            RpcErrorCode.InvalidParams,
            "Invalid params",
            "group chat required",
          );
          return;
        }
        const guid = str(params, "message_id") ?? str(params, "message_guid");
        const message =
          guid === undefined
            ? undefined
            : messages.find((m) => m.guid === guid && m.chat_id === chat.id);
        if (guid !== undefined && !message) {
          replyError(
            id,
            RpcErrorCode.InvalidParams,
            "Invalid params",
            "unknown message target",
          );
          return;
        }
        if (method.startsWith("poll.") && method !== "poll.send") {
          const poll = messages.find(
            (m) => m.guid === params["poll_guid"] && m.chat_id === chat.id,
          )?.poll;
          const option = poll?.options?.find(
            (o, i) =>
              o.id === params["option_id"] ||
              i + 1 === params["option_index"] ||
              o.text.toLowerCase() === str(params, "option")?.toLowerCase(),
          );
          if (!option) {
            replyError(
              id,
              RpcErrorCode.InvalidParams,
              "Invalid params",
              "unknown poll option",
            );
            return;
          }
          const selected = poll!.votes ?? [];
          if (
            method === "poll.unvote" &&
            !selected.some(
              (v) => v.option_id === option.id && v.participant === "me",
            )
          ) {
            replyError(
              id,
              RpcErrorCode.InvalidParams,
              "Invalid params",
              "option not currently selected",
            );
            return;
          }
          poll!.votes = selected.filter(
            (v) => v.option_id !== option.id || v.participant !== "me",
          );
          if (method === "poll.vote")
            poll!.votes.push({
              option_id: option.id,
              option_text: option.text,
              participant: "me",
            });
        }
        if (method === "poll.send") {
          const created = appendMessage(chat, "", true);
          created.poll = {
            kind: "created",
            event: "imessage.poll.created",
            poll_guid: created.guid,
            question: String(params["question"]),
            options: (params["options"] as string[]).map((text, i) => ({
              id: `opt-${i + 1}`,
              text,
            })),
          };
          reply(id, {
            ok: true,
            event: created.poll.event,
            guid: created.guid,
            message_id: created.guid,
            poll: created.poll,
            comment: {
              requested: !params["suppress_comment"],
              sent: !params["suppress_comment"],
              verified: !params["suppress_comment"],
            },
          });
          return;
        }
        if (method === "read") {
          chat.unread_count = 0;
          messages
            .filter((m) => m.chat_id === chat.id && !m.is_from_me)
            .forEach((m) => {
              m.is_read = true;
            });
        }
        if (method === "chats.markUnread")
          chat.unread_count = Math.max(1, chat.unread_count ?? 0);
        if (method === "chats.delete") {
          chats.splice(chats.indexOf(chat), 1);
          for (let i = messages.length - 1; i >= 0; i--)
            if (messages[i]!.chat_id === chat.id) messages.splice(i, 1);
        }
        if (method === "group.rename") chat.name = String(params["name"]);
        if (
          method === "group.addParticipant" &&
          !chat.participants.includes(String(params["address"]))
        )
          chat.participants.push(String(params["address"]));
        if (method === "group.removeParticipant")
          chat.participants = chat.participants.filter(
            (p) => p !== params["address"],
          );
        if (method === "message.edit" && message)
          message.text = String(params["text"]);
        if (["message.delete", "message.unsend"].includes(method) && message)
          messages.splice(messages.indexOf(message), 1);
        if (method === "tapback" && message) {
          if (
            params["remove"] ||
            String(params["reaction"]).startsWith("remove-")
          )
            message.reactions = message.reactions.filter((r) => !r.is_from_me);
          else
            message.reactions.push({
              id: nextRowid++,
              type: String(params["reaction"]).replace(
                "emphasize",
                "emphasis",
              ) as import("./types").ReactionName,
              emoji: "",
              sender: "me",
              is_from_me: true,
              created_at: new Date().toISOString(),
            });
        }
        reply(id, {
          ok: true,
          ...(method === "contacts.shouldShareContact"
            ? { can_inspect_offer: true, can_share: true, should_offer: null }
            : {}),
          ...(method === "contacts.shareContactCard"
            ? { requested: true }
            : {}),
        });
        return;
      }
      replyError(
        id,
        RpcErrorCode.MethodNotFound,
        "Method not found",
        `unknown method ${method ?? "(none)"}`,
      );
  }
}

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = integer.positive();
const targetFields = {
  chat_id: positive.optional(),
  chat_guid: z.string().min(1).optional(),
  chat_identifier: z.string().min(1).optional(),
};
const formats = z.array(
  z
    .object({
      start: integer,
      length: positive,
      styles: z.array(z.enum(["bold", "italic", "underline", "strikethrough"])),
    })
    .strict(),
);
const targetSchema = <T extends z.ZodRawShape>(extra: T, direct = false) =>
  z
    .object({
      ...targetFields,
      ...(direct ? { to: z.string().min(1).optional() } : {}),
      ...extra,
    })
    .strict()
    .refine(
      (p) =>
        [
          "chat_id",
          "chat_guid",
          "chat_identifier",
          ...(direct ? ["to"] : []),
        ].filter((k) => (p as Record<string, unknown>)[k] !== undefined)
          .length === 1,
    );
const schemas: Record<string, z.ZodType> = {
  ...actionSchemas,
  "send.tracked": targetSchema(
    {
      text: z.string().trim().min(1),
      attempt_id: z.uuid(),
      service: z.enum(["auto", "imessage", "sms"]).optional(),
      transport: z.literal("bridge").optional(),
      allow_sms_fallback: z.literal(false).optional(),
    },
    true,
  ),
  status: z.object({}).strict(),
  initialize: z.object({ protocol_version: z.literal(1).optional() }).strict(),
  "chats.list": z
    .object({ limit: positive.optional(), unread_only: z.boolean().optional() })
    .strict(),
  "chats.get": z.object({ chat_id: positive }).strict(),
  "messages.search": z
    .object({
      query: z.string().trim().min(1),
      match: z.enum(["contains", "exact"]).optional(),
      limit: positive.max(100).optional(),
    })
    .strict(),
  "messages.after": z
    .object({
      since_rowid: integer,
      chat_id: positive.optional(),
      limit: positive.max(500).optional(),
      attachments: z.boolean().optional(),
      convert_attachments: z.boolean().optional(),
      include_reactions: z.boolean().optional(),
    })
    .strict(),
  "messages.history": z
    .object({
      chat_id: positive,
      limit: positive.optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      participants: z.array(z.string()).optional(),
      attachments: z.boolean().optional(),
      convert_attachments: z.boolean().optional(),
    })
    .strict(),
  "messages.scheduled": z.object({ limit: positive.optional() }).strict(),
  "messages.stats": z
    .object({
      chat_id: positive.optional(),
      time_zone: z.string().optional(),
      include_media: z.boolean().optional(),
    })
    .strict(),
  "watch.subscribe": z
    .object({
      chat_id: positive.optional(),
      since_rowid: z.number().int().min(-1).optional(),
      attachments: z.boolean().optional(),
      convert_attachments: z.boolean().optional(),
      include_reactions: z.boolean().optional(),
      buffer_limit: positive.max(4096).optional(),
      debounce_ms: integer.optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      participants: z.array(z.string()).optional(),
    })
    .strict(),
  "watch.unsubscribe": z.object({ subscription: positive }).strict(),
  send: targetSchema(
    {
      text: z.string().optional(),
      file: z.string().optional(),
      service: z.enum(["auto", "imessage", "sms"]).optional(),
      allow_sms_fallback: z.boolean().optional(),
      reply_to: z.string().optional(),
      text_formatting: formats.optional(),
      transport: z.enum(["auto", "bridge", "applescript"]).optional(),
      region: z.string().optional(),
    },
    true,
  ).refine((p) => Boolean(p["text"] || p["file"])),
  "send.rich": targetSchema({
    text: z.string().optional(),
    file: z.string().optional(),
    url: z.url().optional(),
    reply_to: z.string().optional(),
    subject: z.string().optional(),
    effect_id: z.string().optional(),
    text_formatting: formats.optional(),
  }),
  "send.attachment": targetSchema({
    file: z.string().min(1),
    audio: z.boolean().optional(),
    reply_to: z.string().optional(),
    part_index: integer.optional(),
  }),
  "send.sticker": targetSchema({
    file: z.string().min(1),
    attach_to: z.string().optional(),
    part_index: integer.optional(),
  }),
  "send.multipart": targetSchema({
    parts: z
      .array(
        z
          .object({
            text: z.string().min(1),
            text_formatting: formats.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    subject: z.string().optional(),
    effect_id: z.string().optional(),
  }),
  "message.send_status": z.object({ guid: z.string().min(1) }).strict(),
  "group.setIcon": targetSchema({ file: z.string().optional() }),
};
const denied = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--deny="))
    .map((arg) => arg.slice(7)),
);

const intervalIndex = process.argv.indexOf("--interval");
const intervalMs =
  intervalIndex === -1 ? 0 : Number(process.argv[intervalIndex + 1] ?? "");
let syntheticCount = 0;
if (intervalMs > 0) {
  setInterval(() => {
    const chat = chats[0];
    if (chat)
      appendMessage(chat, `synthetic message ${++syntheticCount}`, false);
  }, intervalMs);
}

for await (const line of console) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let request: MockRequest;
  try {
    request = JSON.parse(trimmed) as MockRequest;
  } catch {
    write({
      jsonrpc: "2.0",
      id: null,
      error: { code: RpcErrorCode.ParseError, message: "Parse error" },
    });
    continue;
  }
  handle(request);
}
process.exit(0);
