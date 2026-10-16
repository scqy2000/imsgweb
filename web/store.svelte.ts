import { connectEvents, type EventsHandle } from "./events";
import {
  applyReactionEvent,
  bumpChat,
  filterChats,
  updateEditedMessage,
  upsertMessage,
} from "./model";
import { ApiError, mutationFailure, request } from "./service";
import { toasts } from "./toast.svelte";
import type { ApiChat, ApiMessage } from "../server/payloads";
import { SvelteURLSearchParams } from "svelte/reactivity";
import { HistoryRequests } from "./history";

export type SendState = "pending" | "sent" | "delivered" | "read" | "failed";
export interface ServerStatus {
  version: string;
  protocol_version: number;
  methods: string[];
  supported_methods: string[];
  database: {
    ready: boolean;
    error?: string;
    features?: Record<string, boolean>;
  };
  bridge: { ready: boolean; error?: string };
  contacts?: { available: boolean };
}
export interface SendInput {
  text?: string;
  file?: File;
  mode?:
    | "standard"
    | "rich"
    | "audio"
    | "sticker"
    | "url"
    | "multipart"
    | "tracked";
  attempt_id?: string;
  service?: string;
  allow_sms_fallback?: boolean;
  reply_to?: string;
  subject?: string;
  effect_id?: string;
  url?: string;
  parts?: Array<{ text: string }>;
  text_formatting?: Array<{ start: number; length: number; styles: string[] }>;
}
interface HistoryPage {
  messages: ApiMessage[];
  next_before: string | null;
  next_before_rowid?: number | null;
}

class Store {
  chats = $state<ApiChat[]>([]);
  selectedChatId = $state<number | null>(null);
  messages = $state<Record<number, ApiMessage[]>>({});
  cursors = $state<Record<number, string | null>>({});
  rowCursors = $state<Record<number, number | null>>({});
  sendStates = $state<Record<string, SendState>>({});
  live = $state(false);
  chatsLoading = $state(false);
  historyLoading = $state<Record<number, boolean>>({});
  sidebarOpen = $state(true);
  highlightedGuid = $state<string | null>(null);
  composing = $state(false);
  infoOpen = $state(false);
  view = $state<"chat" | "search" | "stats" | "scheduled" | "status">("chat");
  status = $state<ServerStatus | null>(null);
  statusError = $state("");
  chatQuery = $state("");
  unreadOnly = $state(false);
  chatLimit = $state(50);
  moreChats = $state(true);
  searchQuery = $state("");
  searchChatId = $state<number | null>(null);
  searchResults = $state<ApiMessage[]>([]);
  searchLoading = $state(false);
  searchError = $state("");
  searchWarning = $state("");
  searchMore = $state(false);
  searchLimit = $state(50);
  searchCursor = $state<string | null>(null);
  replyTo = $state<ApiMessage | null>(null);
  focusedResult = $state(false);
  mutationBusy = $state(false);
  lastAttemptId = $state<string | null>(null);
  attemptState = $state("");
  uncertainty = $state<{ message: string; blocked: boolean } | null>(null);
  #highlightTimer: ReturnType<typeof setTimeout> | null = null;
  #events: EventsHandle | null = null;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #chatLoad = 0;
  #searchLoad = 0;
  readonly #history = new HistoryRequests();
  #active = false;
  #unreadRefresh: ReturnType<typeof setTimeout> | null = null;
  selectedChat = $derived(
    this.chats.find((chat) => chat.id === this.selectedChatId),
  );
  visibleChats = $derived(
    filterChats(this.chats, this.chatQuery, this.unreadOnly),
  );

  supports(method: string): boolean {
    return this.status?.methods.includes(method) ?? false;
  }
  capabilityReason(method: string): string {
    if (this.supports(method)) return "";
    if (!this.status) return this.statusError || "正在读取服务能力";
    if (!this.status.database.ready)
      return this.status.database.error || "Messages 数据库不可读";
    return this.status.bridge.error || "当前 imsg 不支持此操作";
  }
  async start(): Promise<void> {
    this.#active = true;
    await this.refreshStatus();
    this.#statusTimer ??= setInterval(() => {
      void this.refreshStatus();
    }, 30_000);
    await this.loadChats();
  }
  stop(): void {
    this.#active = false;
    this.#events?.close();
    this.#events = null;
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    this.#statusTimer = null;
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    if (this.#unreadRefresh) clearTimeout(this.#unreadRefresh);
  }
  async refreshStatus(): Promise<void> {
    try {
      this.status = await request<ServerStatus>("/api/status");
      this.statusError = "";
      if (this.#active && this.supports("watch.subscribe") && !this.#events)
        this.#events = connectEvents({
          onMessage: (message) => this.handleEvent(message),
          onStateChange: (live) => {
            this.live = live;
          },
          onReset: () => {
            void this.loadChats();
            if (this.selectedChatId !== null) void this.latest();
          },
        });
      if (!this.supports("watch.subscribe")) {
        this.#events?.close();
        this.#events = null;
        this.live = false;
      }
    } catch (error) {
      this.statusError =
        error instanceof Error ? error.message : "能力查询失败";
    }
  }
  async loadChats(more = false): Promise<void> {
    if (more) this.chatLimit = Math.min(5000, this.chatLimit + 50);
    const generation = ++this.#chatLoad;
    this.chatsLoading = true;
    try {
      const result = await request<{ chats: ApiChat[] }>(
        `/api/chats?limit=${this.chatLimit}&unread_only=${this.unreadOnly}`,
      );
      if (generation !== this.#chatLoad) return;
      const selected = this.selectedChat;
      this.chats = result.chats;
      if (selected && !this.chats.some((chat) => chat.id === selected.id))
        this.chats = [...this.chats, selected];
      this.moreChats =
        result.chats.length === this.chatLimit && this.chatLimit < 5000;
    } catch (error) {
      this.report(error);
    } finally {
      if (generation === this.#chatLoad) this.chatsLoading = false;
    }
  }
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }
  openView(view: typeof this.view): void {
    this.view = view;
    this.composing = false;
    if (!window.matchMedia("(min-width: 768px)").matches)
      this.sidebarOpen = false;
  }
  startCompose(): void {
    this.replyTo = null;
    this.selectedChatId = null;
    this.openView("chat");
    this.composing = true;
  }
  cancelCompose(): void {
    this.composing = false;
  }
  async compose(
    to: string,
    text: string,
    service = "auto",
    allowSms = false,
  ): Promise<boolean> {
    const form = new FormData();
    form.set("to", to);
    form.set("text", text);
    form.set("service", service);
    form.set("allow_sms_fallback", String(allowSms));
    const result = await this.mutate<Record<string, unknown>>("/api/messages", {
      method: "POST",
      body: form,
    });
    if (!result) return false;
    this.composing = false;
    await this.loadChats();
    const chat = this.chats.find(
      (c) => c.guid === result["chat_guid"] || c.identifier === to,
    );
    if (chat) await this.select(chat.id);
    return true;
  }
  async select(chatId: number): Promise<void> {
    this.composing = false;
    this.view = "chat";
    this.infoOpen = false;
    if (chatId !== this.selectedChatId) this.replyTo = null;
    this.selectedChatId = chatId;
    if (!window.matchMedia("(min-width: 768px)").matches)
      this.sidebarOpen = false;
    if (!this.chats.some((chat) => chat.id === chatId)) {
      try {
        const info = await request<ApiChat>(`/api/chats/${chatId}/info`);
        this.chats = [
          ...this.chats,
          {
            ...info,
            last_message_at: info.last_message_at ?? "",
            display_name:
              info.name || info.identifier || info.participants.join(", "),
            last_message: null,
          },
        ];
      } catch (error) {
        this.report(error);
        return;
      }
    }
    if (!(chatId in this.messages)) await this.loadHistory(chatId);
  }
  async loadOlder(chatId: number): Promise<void> {
    const cursor = this.cursors[chatId];
    if (cursor != null)
      await this.loadHistory(
        chatId,
        cursor,
        this.rowCursors[chatId] ?? undefined,
      );
  }
  async loadHistory(
    chatId: number,
    before?: string,
    rowid?: number,
  ): Promise<void> {
    await this.#history.run(chatId, () =>
      this.#fetchHistory(chatId, before, rowid),
    );
  }
  async #fetchHistory(
    chatId: number,
    before?: string,
    rowid?: number,
    replace = false,
  ): Promise<void> {
    this.historyLoading[chatId] = true;
    const query = new SvelteURLSearchParams();
    if (rowid !== undefined) query.set("before_rowid", String(rowid));
    if (before) query.set("before", before);
    try {
      const page = await request<HistoryPage>(
        `/api/chats/${chatId}/messages?${query}`,
      );
      let list = replace ? [] : (this.messages[chatId] ?? []);
      for (const message of page.messages) list = upsertMessage(list, message);
      this.messages[chatId] = list;
      this.cursors[chatId] = page.next_before;
      this.rowCursors[chatId] = page.next_before_rowid ?? null;
    } catch (error) {
      this.report(error);
    } finally {
      this.historyLoading[chatId] = false;
    }
  }
  async latest(): Promise<void> {
    const id = this.selectedChatId;
    if (id === null) return;
    await this.#history.replace(id, () =>
      this.#fetchHistory(id, undefined, undefined, true),
    );
    if (this.selectedChatId === id) this.focusedResult = false;
  }
  jumpToMessage(chatId: number, guid: string): void {
    if (!(this.messages[chatId] ?? []).some((m) => m.guid === guid)) {
      toasts.info("引用消息尚未加载，请向上加载历史");
      return;
    }
    this.highlightedGuid = guid;
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    this.#highlightTimer = setTimeout(() => {
      this.highlightedGuid = null;
    }, 2400);
  }
  async openResult(message: ApiMessage): Promise<void> {
    await this.select(message.chat_id);
    await this.#history.replace(message.chat_id, () =>
      this.#fetchHistory(
        message.chat_id,
        new Date(Date.parse(message.created_at) + 1).toISOString(),
        undefined,
        true,
      ),
    );
    this.messages[message.chat_id] = upsertMessage(
      this.messages[message.chat_id] ?? [],
      message,
    );
    this.focusedResult = true;
    this.jumpToMessage(message.chat_id, message.guid);
  }
  async searchMessages(more = false): Promise<void> {
    if (!this.searchQuery.trim()) return;
    this.openView("search");
    this.searchLimit = 50;
    if (!more) this.searchCursor = null;
    const token = ++this.#searchLoad;
    const query = new SvelteURLSearchParams({
      query: this.searchQuery,
      limit: String(this.searchLimit),
    });
    if (this.searchChatId !== null)
      query.set("chat_id", String(this.searchChatId));
    if (more && this.searchCursor) query.set("before", this.searchCursor);
    this.searchLoading = true;
    this.searchError = "";
    this.searchWarning = "";
    try {
      const result = await request<{
        messages: ApiMessage[];
        next_before: string | null;
        truncated?: boolean;
        warning?: string;
      }>(`/api/search?${query}`);
      if (token !== this.#searchLoad) return;
      this.searchResults = more
        ? [
            ...this.searchResults,
            ...result.messages.filter(
              (message) =>
                !this.searchResults.some(
                  (existing) => existing.id === message.id,
                ),
            ),
          ]
        : result.messages;
      this.searchCursor = result.next_before;
      this.searchMore = result.next_before !== null;
      this.searchWarning = result.truncated
        ? "imsg 的原生搜索最多返回全局最新 100 条匹配；更早的消息和会话筛选结果可能不完整。"
        : "";
    } catch (error) {
      this.searchError = error instanceof Error ? error.message : "搜索失败";
      this.report(error);
    } finally {
      if (token === this.#searchLoad) this.searchLoading = false;
    }
  }
  async send(input: SendInput): Promise<boolean> {
    const chat = this.selectedChat;
    if (!chat) return false;
    this.lastAttemptId = input.attempt_id ?? null;
    this.attemptState = "";
    const form = new FormData();
    form.set("chat_id", String(chat.id));
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      form.set(
        key,
        value instanceof File
          ? value
          : Array.isArray(value)
            ? JSON.stringify(value)
            : String(value),
      );
    }
    form.set("allow_sms_fallback", String(input.allow_sms_fallback ?? false));
    const result = await this.mutate<Record<string, unknown>>("/api/messages", {
      method: "POST",
      body: form,
    });
    if (!result) return false;
    this.replyTo = null;
    await this.loadHistory(chat.id);
    return true;
  }
  async checkAttempt(): Promise<void> {
    if (!this.lastAttemptId) return;
    try {
      const result = await request<{
        send_state: SendState;
        status_fields: unknown;
      }>(`/api/messages/${encodeURIComponent(this.lastAttemptId)}/status`);
      this.attemptState =
        result.status_fields === null
          ? "尚未找到此消息，不能据此判断未发送"
          : `此消息状态：${result.send_state}`;
    } catch (error) {
      this.report(error);
    }
  }
  async runAction(
    method: string,
    params: Record<string, unknown>,
    confirmed = false,
  ): Promise<Record<string, unknown> | null> {
    if (["handles.check", "contacts.shouldShareContact"].includes(method)) {
      try {
        return await request<Record<string, unknown>>("/api/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method, params, confirmed }),
        });
      } catch (error) {
        this.report(error);
        return null;
      }
    }
    const result = await this.mutate<Record<string, unknown>>("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params, confirmed }),
    });
    if (!result) return null;
    if (
      !["typing", "handles.check", "contacts.shouldShareContact"].includes(
        method,
      )
    ) {
      if (method === "chats.delete" && typeof params["chat_id"] === "number") {
        const deletedId = params["chat_id"];
        if (this.selectedChatId === deletedId) {
          this.selectedChatId = null;
          this.infoOpen = false;
          this.replyTo = null;
        }
        this.chats = this.chats.filter((chat) => chat.id !== deletedId);
        delete this.messages[deletedId];
        delete this.cursors[deletedId];
        delete this.rowCursors[deletedId];
      }
      await this.loadChats();
      const chatId =
        typeof params["chat_id"] === "number"
          ? params["chat_id"]
          : this.selectedChatId;
      if (
        chatId !== null &&
        !["chats.delete", "group.leave"].includes(method)
      ) {
        if (method === "message.edit" && typeof params["text"] === "string") {
          const guid = params["message_guid"] ?? params["message_id"];
          if (typeof guid === "string")
            this.messages[chatId] = updateEditedMessage(
              this.messages[chatId] ?? [],
              guid,
              params["text"],
            );
        }
        if (["message.delete", "message.unsend"].includes(method)) {
          await this.#history.replace(chatId, () =>
            this.#fetchHistory(chatId, undefined, undefined, true),
          );
        } else await this.loadHistory(chatId);
      }
      const comment = result["comment"] as
        | { requested?: boolean; sent?: boolean | null; error?: string }
        | undefined;
      if (comment?.requested && comment.sent !== true)
        toasts.info(
          `投票已创建，附带说明未确认送达：${comment.error ?? "请在信息中核对"}`,
        );
    }
    return result;
  }
  async mutate<T extends Record<string, unknown>>(
    path: string,
    init: RequestInit,
  ): Promise<T | null> {
    if (this.mutationBusy || this.uncertainty) return null;
    if (path !== "/api/messages") this.lastAttemptId = null;
    this.mutationBusy = true;
    try {
      const result = await request<T>(path, init);
      if (typeof result["guid"] === "string")
        void this.trackSendStatus(result["guid"]);
      return result;
    } catch (error) {
      const failure = mutationFailure(error);
      if (failure.uncertain || failure.blocked)
        this.uncertainty = {
          message: failure.message,
          blocked: failure.blocked,
        };
      this.report(error);
      return null;
    } finally {
      this.mutationBusy = false;
    }
  }
  async trackSendStatus(guid: string): Promise<void> {
    this.sendStates[guid] = "pending";
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const result = await request<{
          send_state: SendState;
          status_fields?: { date_read?: string | null } | null;
        }>(`/api/messages/${encodeURIComponent(guid)}/status`);
        const state = result.status_fields?.date_read
          ? "read"
          : result.send_state;
        this.sendStates[guid] = state;
        if (state === "read" || state === "failed") return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, attempt < 5 ? 1500 : 5000),
      );
    }
  }
  report(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) return;
    toasts.error(error instanceof Error ? error.message : "请求失败");
  }
  handleEvent(message: ApiMessage): void {
    if (message.is_reaction) {
      const list = this.messages[message.chat_id];
      if (list)
        this.messages[message.chat_id] = applyReactionEvent(list, message);
      return;
    }
    const list = this.messages[message.chat_id];
    const alreadySeen = list?.some((m) => m.id === message.id) ?? false;
    if (list) this.messages[message.chat_id] = upsertMessage(list, message);
    const bumped = bumpChat(this.chats, message);
    if (bumped === null) void this.loadChats();
    else {
      this.chats = bumped;
      if (!alreadySeen && !message.is_from_me && message.is_read !== true) {
        const chat = this.chats.find((c) => c.id === message.chat_id);
        if (chat) chat.unread_count = (chat.unread_count ?? 0) + 1;
      }
      this.#unreadRefresh ??= setTimeout(() => {
        this.#unreadRefresh = null;
        void this.loadChats();
      }, 1500);
    }
  }
}
export const store = new Store();
