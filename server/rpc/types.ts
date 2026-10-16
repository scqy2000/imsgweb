/**
 * Wire types for `imsg rpc` — JSON-RPC 2.0, one JSON object per line over
 * stdio. Matches the public imsg v0.17.0 contract; upstream schema
 * changes are additive-only, so treat unknown fields as ignorable.
 *
 * Everything on the wire is snake_case. Dates are ISO-8601 UTC with
 * fractional seconds. Inapplicable fields are omitted rather than null,
 * except where a type says `| null` explicitly.
 */

/* ── JSON-RPC framing ────────────────────────────────────────────────────── */

export type RpcId = string | number;

export interface RpcRequest<M extends ImsgMethod = ImsgMethod> {
  jsonrpc?: "2.0";
  /** Requests without an id get no response. */
  id?: RpcId;
  method: M;
  params?: ImsgRpcMethods[M]["params"];
}

export type RpcResponse<M extends ImsgMethod = ImsgMethod> =
  | { jsonrpc: "2.0"; id: RpcId; result: ImsgRpcMethods[M]["result"] }
  | { jsonrpc: "2.0"; id: RpcId | null; error: RpcErrorObject };

export type RpcNotification =
  | WatchMessageNotification
  | WatchErrorNotification
  | WatchOverflowNotification;

export interface DeliveryErrorData {
  retry_safe: boolean;
  disposition: "not_started" | "may_have_completed" | "still_in_flight";
  transport: string;
  operation: string;
  detail: string;
}

export interface RpcErrorObject {
  code: RpcErrorCode;
  /** Fixed label per code; the human-readable detail is in `data`. */
  message: string;
  data?: string | DeliveryErrorData;
}

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  /** Also covers domain validation (bad chat target, unknown chat_id, …). */
  InvalidParams: -32602,
  /** Internal failures, including "bridge not injected". */
  InternalError: -32603,
  ServerBusy: -32000,
  DeliveryUnknown: -32001,
  DatabaseUnavailable: -32002,
  BridgeUnavailable: -32003,
  MutationBlocked: -32004,
} as const;
export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

/* ── Shared scalars ──────────────────────────────────────────────────────── */

/** ISO-8601 UTC with milliseconds, e.g. "2026-06-03T21:12:12.123Z". */
export type Iso8601 = string;

export type SendService = "auto" | "imessage" | "sms";

/** Service as stored in chat.db — open set ("RCS" appears on newer macOS). */
export type ChatService = "iMessage" | "SMS" | (string & Record<never, never>);

/** Tapback name as it appears in payloads (DB naming: "emphasis"). */
export type ReactionName =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasis"
  | "question"
  /** Custom emoji reaction; the emoji itself is in `emoji`. */
  | "custom";

/** Tapback name the `tapback` method accepts (bridge naming: "emphasize" —
 *  the asymmetry with ReactionName's "emphasis" is real, don't "fix" it). */
export type TapbackInput =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | `remove-${"love" | "like" | "dislike" | "laugh" | "emphasize" | "question"}`;

/** Expressive-send effect: a short name (expanded server-side) or a full
 *  "com.apple." bundle id (passed through). */
export type EffectShortName =
  | "impact"
  | "loud"
  | "gentle"
  | "invisibleink"
  | "confetti"
  | "lasers"
  | "fireworks"
  | "balloons"
  | "sparkles"
  | "spotlight"
  | "echo"
  | "love"
  | "celebration";
export type EffectId = EffectShortName | `com.apple.${string}`;

/** Style runs over `text`; offsets are UTF-16 code units. Out-of-range runs
 *  are silently skipped; styles render on macOS 15+ only. */
export interface TextFormattingRun {
  start: number;
  length: number;
  styles: Array<"bold" | "italic" | "underline" | "strikethrough">;
}

/** Exactly one addressing mode: `to` (a handle), or one of the chat_* keys.
 *  Bridge-gated methods accept only chat_* targets. */
export interface DirectTarget {
  to: string;
  chat_id?: never;
  chat_identifier?: never;
  chat_guid?: never;
}
export interface ExistingChatTarget {
  to?: never;
  /** chat.db ROWID — preferred, but local to this Mac. */
  chat_id?: number;
  /** e.g. "+15551234567", or "chat123…" for groups. */
  chat_identifier?: string;
  /** e.g. "iMessage;-;+15551234567"; a ";+;" infix marks a group. The
   *  service prefix can also be "any" (observed) — only rely on the infix. */
  chat_guid?: string;
}
export type ChatTarget = DirectTarget | ExistingChatTarget;

/* ── Payload objects (server → client) ───────────────────────────────────── */

export interface ChatPayload {
  display_name?: string;
  unread_count?: number;
  account_id?: string;
  account_login?: string;
  last_addressed_handle?: string;
  /** chat.db ROWID. */
  id: number;
  identifier: string;
  /** "" when unresolvable. */
  guid: string;
  name: string;
  service: ChatService;
  last_message_at: Iso8601;
  /** Raw participant handles (phone numbers / emails). */
  participants: string[];
  is_group: boolean;
  /** Contacts-resolved name; non-group chats only, when matched. */
  contact_name?: string;
}

export interface AttachmentPayload {
  /** Path on disk — OBSERVED to keep the ~ prefix from chat.db (real
   *  v0.11.1 output), while original_path arrives resolved; always expand
   *  ~ before touching the filesystem. */
  filename: string;
  /** Original filename as transferred. */
  transfer_name: string;
  uti: string;
  /** "" when chat.db has no mime hint. */
  mime_type: string;
  total_bytes: number;
  is_sticker: boolean;
  /** Observed as the resolved absolute path. */
  original_path: string;
  /** Not on disk (e.g. pending iCloud download) — can appear later, so
   *  never cache a miss. */
  missing: boolean;
  /** Only with convert_attachments: true, ffmpeg on PATH, and a supported
   *  conversion (CAF→M4A, GIF→PNG). Fall back to `filename`. */
  converted_path?: string;
  converted_mime_type?: string;
}

/** One tapback on a message (the aggregated view). */
export interface ReactionPayload {
  /** ROWID of the reaction row, not the target message. */
  id: number;
  type: ReactionName;
  emoji: string;
  sender: string;
  sender_name?: string;
  is_from_me: boolean;
  created_at: Iso8601;
}

/** Native Messages Polls balloon / vote update. */
export interface PollEventPayload {
  kind: "created" | "vote" | "unknown";
  event:
    | "imessage.poll.created"
    | "imessage.poll.voted"
    | "imessage.poll.unknown";
  poll_guid?: string;
  question?: string;
  options?: Array<{ id: string; text: string }>;
  /** The vote that triggered a vote event. */
  vote?: PollVote;
  votes?: PollVote[];
  /** GUID of the original poll message (vote events). */
  original_guid?: string;
  creator?: string;
  participants?: string[];
  metadata?: {
    bundle_id?: string;
    associated_message_type?: number;
    payload_bytes?: number;
    summary_bytes?: number;
    url_scheme?: string;
    url_host?: string;
    query_keys?: string[];
  };
}
export interface PollVote {
  option_id: string;
  option_text?: string;
  participant?: string;
  event_type?: string;
  server_time?: string;
}

/** Message as returned by `messages.history` and pushed by watch. */
export interface MessagePayload {
  is_read?: boolean;
  date_read?: string;
  balloon_bundle_id?: string;
  url_preview?: {
    id: number;
    guid: string;
    balloon_bundle_id: string;
    created_at: string;
  };
  account_id?: string;
  account_login?: string;
  last_addressed_handle?: string;
  /** chat.db ROWID — monotonic; use as the watch resume cursor. Both
   *  history and watch can re-emit a rowid (URL-preview balloon
   *  replacement) — upsert by id, don't append blindly. */
  id: number;
  chat_id: number;
  /** Stable across devices; "" only for synthetic rows. */
  guid: string;
  /** OBSERVED (v0.11.1): on is_from_me rows in 1:1 chats this is the
   *  PEER's handle, not your own — never use sender alone to identify who
   *  acted; combine with is_from_me. */
  sender: string;
  sender_name?: string;
  is_from_me: boolean;
  /** Attachments render as U+FFFC placeholders, app balloons as U+FFFD. */
  text: string;
  created_at: Iso8601;
  /** Empty unless the request set attachments: true. */
  attachments: AttachmentPayload[];
  /** history: always aggregated; watch: only with include_reactions. */
  reactions: ReactionPayload[];

  /* Reply / thread routing. CAUTION: chat.db populates reply_to_guid on
   * ordinary consecutive messages too (Apple-internal send/sequence
   * linkage, observed in real data) — it does NOT prove an inline reply.
   * Only thread_originator_guid marks a genuine reply; reply_to_text /
   * reply_to_sender are joined from whichever guid resolves. */
  reply_to_guid?: string;
  thread_originator_guid?: string;
  thread_originator_part?: string;
  /** Omitted if the parent message is gone from chat.db. */
  reply_to_text?: string;
  reply_to_sender?: string;

  /** Which of your aliases routed the message. Observed on incoming rows
   *  too, not just is_from_me. */
  destination_caller_id?: string;

  poll?: PollEventPayload;

  /* Set together when the row itself is a tapback add/remove. Watch streams
   * with include_reactions deliver these; history excludes such rows. */
  is_reaction?: true;
  reaction_type?: ReactionName;
  reaction_emoji?: string;
  /** true = added, false = removed. */
  is_reaction_add?: boolean;
  /** GUID of the message being (un)reacted to. */
  reacted_to_guid?: string;

  /* Chat context, present on every RPC message payload. */
  chat_identifier: string;
  chat_guid: string;
  chat_name: string;
  participants: string[];
  is_group: boolean;
}

/* ── Core methods (work with SIP enabled) ────────────────────────────────── */

export interface ChatsListParams {
  unread_only?: boolean;
  /** Default 20. Most-recent-first. */
  limit?: number;
}
export interface ChatsListResult {
  chats: ChatPayload[];
}

export interface MessagesHistoryParams {
  /** chat.db ROWID. */
  chat_id: number;
  /** Default 50 — the most recent N within the window, returned
   *  NEWEST→OLDEST (docs/rpc.md claims oldest→newest, but the handler
   *  never reverses its date-DESC query — sort client-side). No rowid
   *  cursor; page by passing the oldest received created_at as `end`. */
  limit?: number;
  /** Filter by sender handle. */
  participants?: string[];
  /** Inclusive (m.date >= start). */
  start?: Iso8601;
  /** EXCLUSIVE (m.date < end), despite docs saying inclusive. */
  end?: Iso8601;
  attachments?: boolean;
  convert_attachments?: boolean;
}
export interface MessagesHistoryResult {
  messages: MessagePayload[];
}

export interface WatchSubscribeParams {
  buffer_limit?: number;
  /** Omit for the all-chats stream. */
  chat_id?: number;
  /** Exclusive resume cursor: deliver rows with ROWID > since_rowid. */
  since_rowid?: number;
  participants?: string[];
  start?: Iso8601;
  end?: Iso8601;
  attachments?: boolean;
  convert_attachments?: boolean;
  /** Also stream tapback add/remove rows as reaction events. */
  include_reactions?: boolean;
  /** Default 500. */
  debounce_ms?: number;
}
export interface WatchSubscribeResult {
  buffer_limit?: number;
  /** Handle for unsubscribe; echoed on every notification. */
  subscription: number;
}

export interface WatchMessageNotification {
  jsonrpc: "2.0";
  method: "message";
  params: { subscription: number; message: MessagePayload };
}
/** The subscription is dead — resubscribe with since_rowid = last seen id. */
export interface WatchErrorNotification {
  jsonrpc: "2.0";
  method: "error";
  params: {
    subscription: number;
    error: {
      message: string;
      code?: number;
      data?: string | DeliveryErrorData;
    };
  };
}

export interface WatchOverflowNotification {
  jsonrpc: "2.0";
  method: "watch.overflow";
  params: {
    subscription: number;
    resume_after_rowid: number;
    reason: string;
    terminal: true;
  };
}

export interface WatchUnsubscribeParams {
  subscription: number;
}
export interface OkResult {
  ok: true;
}

export type SendParams = ChatTarget & {
  allow_sms_fallback?: boolean;
  reply_to?: string;
  text_formatting?: TextFormattingRun[];
  /** At least one of text/file is required. */
  text?: string;
  /** Absolute path. */
  file?: string;
  /** Default "auto" — may silently fall back to SMS on direct text sends. */
  service?: SendService;
  /** Default "auto": bridge for existing chats when injected, else
   *  AppleScript. "bridge" fails instead of falling back. */
  transport?: "auto" | "bridge" | "applescript";
  /** Phone-number normalization region, default "US". */
  region?: string;
};
export interface SendResult {
  ok: true;
  transport?: "bridge" | "applescript";
  /** chat.db ROWID; best-effort, AppleScript path only. */
  id?: number;
  guid?: string;
  /** Duplicate of guid. */
  message_id?: string;
  chat_guid?: string;
  service?: string;
}

export type SendTrackedParams = ChatTarget & {
  text: string;
  attempt_id: string;
  service?: SendService;
  transport?: "bridge";
  allow_sms_fallback?: false;
};

export interface MessageSendStatusParams {
  guid: string;
}
export interface MessageSendStatusResult {
  ok: true;
  guid: string;
  /** Unknown GUIDs report "pending" with null service/status_fields. */
  send_state: "pending" | "sent" | "delivered" | "failed";
  service: string | null;
  checked_at: Iso8601;
  status_fields: SendStatusFields | null;
  /** Only when delivered. */
  delivered_at?: Iso8601;
}
export interface SendStatusFields {
  is_sent: boolean;
  is_delivered: boolean;
  is_finished: boolean;
  /** Raw chat.db error code; nonzero forces send_state "failed". Opaque —
   *  no public mapping exists. */
  error: number;
  date_delivered: Iso8601 | null;
  /** Recipient read receipt for your outgoing message. */
  date_read: Iso8601 | null;
  is_delayed: boolean;
  is_prepared: boolean;
  is_pending_satellite_send: boolean;
  was_downgraded: boolean;
}

/* ── Bridge-gated methods ─────────────────────────────────────────────────
 * Require SIP off + `imsg launch` injection; fail with InternalError when
 * the bridge is absent. Probe `imsg status --json` once at startup instead
 * of catching errors per call. */

export type SendRichParams = ExistingChatTarget & {
  file?: string;
  url?: string;
  text?: string;
  effect_id?: EffectId;
  subject?: string;
  /** GUID to reply to (renders as an inline thread). */
  reply_to?: string;
  text_formatting?: TextFormattingRun[];
  /** Default 0. */
  part_index?: number;
  /** Data-detector scan (links etc.), default true. */
  dd_scan?: boolean;
};
export interface SendRichResult {
  ok: true;
  /** true → guid was re-verified from chat.db; false → guid is the bridge's
   *  last-sent guid, race-prone under concurrent sends into one chat. */
  queued?: boolean;
  guid?: string;
  message_id?: string;
}

export type SendAttachmentParams = ExistingChatTarget & {
  part_index?: number;
  /** ~ is expanded. */
  file: string;
  /** Send as a native voice message. */
  audio?: boolean;
  reply_to?: string;
};
export interface SendAttachmentResult {
  ok: true;
  guid?: string;
  message_id?: string;
}

export type PollSendParams = ExistingChatTarget & {
  comment?: string;
  suppress_comment?: boolean;
  question: string;
  /** At least 2 non-empty options. */
  options: string[];
  creator_handle?: string;
  reply_to?: string;
};
export interface PollSendResult {
  ok: true;
  event: "imessage.poll.created";
  guid?: string;
  message_id?: string;
  poll?: Record<string, unknown>;
  comment?: {
    requested: boolean;
    sent: boolean | null;
    verified?: boolean;
    message_guid?: string;
    error?: string;
    retry_safe?: boolean;
    disposition?: DeliveryErrorData["disposition"];
  };
}

export type TapbackParams = ExistingChatTarget &
  MessageTarget & {
    reaction: TapbackInput;
    /** Alternative to the "remove-" prefix. */
    remove?: boolean;
    part_index?: number;
  };
export interface TapbackResult {
  ok: true;
  /** The normalized kind actually sent. */
  reaction: TapbackInput;
}

/** Your own typing indicator (there is no API for observing the other
 *  party's). Unusual among bridge methods: also accepts a direct `to`. */
export type TypingParams = ChatTarget & {
  /** true = show bubble, false = clear. Default true. */
  typing?: boolean;
  /** For direct targets. Default "imessage". */
  service?: "imessage" | "sms";
};

/** Mark a chat read on this device — clears the Messages.app badge and may
 *  fire a read receipt. */
export type ReadParams = ChatTarget;

/** Within Apple's edit window. */
export type MessageTarget =
  | { message_id: string; message_guid?: never }
  | { message_guid: string; message_id?: never };
export type MessageEditParams = ExistingChatTarget &
  MessageTarget & {
    text: string;
    /** Fallback for clients that can't render edits; defaults to `text`. */
    backwards_compatibility_message?: string;
    part_index?: number;
  };
/** Within Apple's unsend window. */
export type MessageUnsendParams = ExistingChatTarget &
  MessageTarget & {
    part_index?: number;
  };
/** Local delete (this device's view only). */
export type MessageDeleteParams = ExistingChatTarget & MessageTarget;
/** Break through Focus/DND for a message. */
export type MessageNotifyAnywaysParams = ExistingChatTarget & MessageTarget;

/** The only way to create group threads (direct `send` can create 1:1s). */
export interface ChatsCreateParams {
  addresses: string[];
  /** Default "iMessage". */
  service?: string;
  /** Group display name. */
  name?: string;
  /** Optional first message. */
  text?: string;
}
export interface ChatsCreateResult {
  ok: true;
  chat_guid?: string;
  message_guid?: string;
  service?: string;
}

export type ChatsDeleteParams = ExistingChatTarget;
export type ChatsMarkUnreadParams = ExistingChatTarget;
export type GroupRenameParams = ExistingChatTarget & { name: string };
/** Omit `file` to clear the group photo. */
export type GroupSetIconParams = ExistingChatTarget & { file?: string };
export type GroupAddParticipantParams = ExistingChatTarget & {
  address: string;
};
export type GroupRemoveParticipantParams = ExistingChatTarget & {
  address: string;
};
export type GroupLeaveParams = ExistingChatTarget;

/** Is this address iMessage-reachable? SMS checks are rejected. */
export interface HandlesCheckParams {
  address: string;
  /** Inferred from "@" when omitted. */
  alias_type?: "phone" | "email";
  service?: "iMessage";
}
export interface HandlesCheckResult {
  ok: true;
  address: string;
  alias_type: "phone" | "email";
  service: "iMessage";
  /** Normalized destination URI when resolved. */
  destination?: string;
  /** Raw IDS status code — opaque diagnostic; use `available` for logic. */
  id_status?: number;
  available?: boolean;
}

/* ── Method map ──────────────────────────────────────────────────────────── */

export interface StatusResult {
  version: string;
  protocol_version: number;
  database: {
    path?: string;
    ready: boolean;
    error?: string;
    features?: Record<string, boolean>;
  };
  bridge: {
    ready: boolean;
    error?: string;
    bridge_version?: number;
    v2_ready?: boolean;
    registry_available?: boolean;
    selectors?: Record<string, boolean>;
  };
  contacts: { available: boolean };
  methods: string[];
  supported_methods: string[];
}
export type ChatInfo = Omit<ChatPayload, "last_message_at">;
export interface ScheduledMessagePayload {
  id: number;
  guid: string;
  chat_id: number;
  chat_identifier: string;
  chat_guid: string;
  chat_name: string;
  text: string;
  service: string;
  scheduled_at: string;
  schedule_type: number;
  schedule_state: number;
}
export interface StatsResult {
  total_messages: number;
  sent_messages: number;
  received_messages: number;
  time_zone: string;
  chats: Record<string, unknown>[];
  senders: Record<string, unknown>[];
  services: Record<string, unknown>[];
  dates: Record<string, unknown>[];
  media?: Record<string, unknown>;
}
export type PollVoteParams = ExistingChatTarget & {
  poll_guid: string;
  option_id?: string;
  option_index?: number;
  option?: string;
};
export type SendMultipartParams = ExistingChatTarget & {
  parts: Array<{ text: string; text_formatting?: TextFormattingRun[] }>;
  effect_id?: EffectId;
  subject?: string;
};
export type SendStickerParams = ExistingChatTarget & {
  file: string;
  attach_to?: string;
  part_index?: number;
};

export interface ImsgRpcMethods {
  status: { params: Record<string, never>; result: StatusResult };
  initialize: { params: { protocol_version?: 1 }; result: StatusResult };
  "chats.get": { params: { chat_id: number }; result: ChatInfo };
  "messages.search": {
    params: { query: string; match?: "contains" | "exact"; limit?: number };
    result: MessagesHistoryResult;
  };
  "messages.stats": {
    params: { chat_id?: number; time_zone?: string; include_media?: boolean };
    result: StatsResult;
  };
  "messages.scheduled": {
    params: { limit?: number };
    result: { messages: ScheduledMessagePayload[] };
  };
  "messages.after": {
    params: {
      since_rowid: number;
      chat_id?: number;
      limit?: number;
      attachments?: boolean;
      convert_attachments?: boolean;
      include_reactions?: boolean;
    };
    result: MessagesHistoryResult & { next_rowid: number; has_more: boolean };
  };
  "send.multipart": {
    params: SendMultipartParams;
    result: SendResult & { parts_count: number };
  };
  "send.sticker": {
    params: SendStickerParams;
    result: SendResult & { transfer_guid: string };
  };
  "poll.vote": { params: PollVoteParams; result: OkResult };
  "poll.unvote": { params: PollVoteParams; result: OkResult };
  "contacts.shouldShareContact": {
    params: ExistingChatTarget;
    result: {
      ok: boolean;
      can_inspect_offer: boolean;
      can_share: boolean;
      should_offer: boolean | null;
    };
  };
  "contacts.shareContactCard": {
    params: ExistingChatTarget;
    result: OkResult & { requested: boolean };
  };
  /* core */
  "chats.list": { params: ChatsListParams; result: ChatsListResult };
  "messages.history": {
    params: MessagesHistoryParams;
    result: MessagesHistoryResult;
  };
  "watch.subscribe": {
    params: WatchSubscribeParams;
    result: WatchSubscribeResult;
  };
  "watch.unsubscribe": { params: WatchUnsubscribeParams; result: OkResult };
  send: { params: SendParams; result: SendResult };
  "send.tracked": {
    params: SendTrackedParams;
    result: SendResult & {
      attempt_id: string;
      guid: string;
      message_id: string;
    };
  };
  "message.send_status": {
    params: MessageSendStatusParams;
    result: MessageSendStatusResult;
  };
  /* bridge-gated */
  "send.rich": { params: SendRichParams; result: SendRichResult };
  "send.attachment": {
    params: SendAttachmentParams;
    result: SendAttachmentResult;
  };
  "poll.send": { params: PollSendParams; result: PollSendResult };
  "messages.poll.send": { params: PollSendParams; result: PollSendResult };
  tapback: { params: TapbackParams; result: TapbackResult };
  typing: { params: TypingParams; result: OkResult };
  read: { params: ReadParams; result: OkResult };
  "message.edit": { params: MessageEditParams; result: OkResult };
  "message.unsend": { params: MessageUnsendParams; result: OkResult };
  "message.delete": { params: MessageDeleteParams; result: OkResult };
  "message.notifyAnyways": {
    params: MessageNotifyAnywaysParams;
    result: OkResult;
  };
  "chats.create": { params: ChatsCreateParams; result: ChatsCreateResult };
  "chats.delete": { params: ChatsDeleteParams; result: OkResult };
  "chats.markUnread": { params: ChatsMarkUnreadParams; result: OkResult };
  "group.rename": { params: GroupRenameParams; result: OkResult };
  "group.setIcon": { params: GroupSetIconParams; result: OkResult };
  "group.addParticipant": {
    params: GroupAddParticipantParams;
    result: OkResult;
  };
  "group.removeParticipant": {
    params: GroupRemoveParticipantParams;
    result: OkResult;
  };
  "group.leave": { params: GroupLeaveParams; result: OkResult };
  "handles.check": { params: HandlesCheckParams; result: HandlesCheckResult };
}
export type ImsgMethod = keyof ImsgRpcMethods;
