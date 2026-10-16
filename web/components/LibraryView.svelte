<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import Clock from "@lucide/svelte/icons/clock";
  import Database from "@lucide/svelte/icons/database";
  import Plug from "@lucide/svelte/icons/plug";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import type { ApiMessage } from "../../server/payloads";
  import { request } from "../service";
  import { store } from "../store.svelte";

  interface Stats {
    total_messages: number;
    sent_messages: number;
    received_messages: number;
    time_zone: string;
    chats: {
      chat_id: number;
      identifier: string;
      name: string;
      service: string;
      message_count: number;
    }[];
    senders: { handle: string; message_count: number }[];
    services: { service: string; message_count: number }[];
    dates: { date: string; message_count: number }[];
    media?: {
      total_attachments: number;
      total_bytes: number;
      types: {
        uti: string;
        mime_type: string;
        attachment_count: number;
        total_bytes: number;
      }[];
      chats: {
        chat_id: number;
        identifier: string;
        name: string;
        attachment_count: number;
        total_bytes: number;
      }[];
    };
  }
  type ScheduledMessage = Pick<
    ApiMessage,
    "id" | "guid" | "chat_id" | "text"
  > & {
    chat_name?: string;
    chat_identifier?: string;
    service?: string;
    scheduled_at?: string;
  };

  let scope = $state<number | null>(null);
  let stats = $state<Stats | null>(null);
  let scheduled = $state<ScheduledMessage[]>([]);
  let loading = $state(false);
  let error = $state("");
  let searchError = $state("");
  let openingError = $state("");
  let revision = $state(0);
  let scheduledLimit = $state(100);
  let refreshing = $state(false);
  let searched = $state(false);
  let resultsKey = $state<string | null>(null);
  let searchRevision = 0;
  let observedSearchKey: string | null = null;
  const headings: Record<string, string> = {
    search: "搜索消息",
    stats: "消息统计",
    scheduled: "定时消息",
    status: "连接状态",
  };
  const title = $derived(headings[store.view] ?? "资料库");
  const methodNames = $derived(
    [
      ...new Set([
        ...(store.status?.methods ?? []),
        ...(store.status?.supported_methods ?? []),
      ]),
    ].sort(),
  );
  const currentSearchKey = $derived(
    JSON.stringify([store.searchQuery.trim(), store.searchChatId]),
  );
  const results = $derived(
    resultsKey === currentSearchKey ? store.searchResults : [],
  );

  $effect(() => {
    const view = store.view;
    const chatId = scope;
    const limit = scheduledLimit;
    void revision;
    const controller = new AbortController();
    stats = null;
    scheduled = [];
    error = "";
    loading = false;
    if (view !== "stats" && view !== "scheduled")
      return () => controller.abort();
    const method = view === "stats" ? "messages.stats" : "messages.scheduled";
    if (!store.supports(method)) {
      error = store.capabilityReason(method);
      return () => controller.abort();
    }
    const query = new SvelteURLSearchParams();
    if (chatId !== null) query.set("chat_id", String(chatId));
    if (view === "scheduled") query.set("limit", String(limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    loading = true;
    if (view === "stats") {
      void request<Stats>(`/api/stats${suffix}`, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) stats = result;
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            error =
              cause instanceof Error ? cause.message : "无法加载消息统计。";
        })
        .finally(() => {
          if (!controller.signal.aborted) loading = false;
        });
    } else {
      void request<{ messages: ScheduledMessage[] }>(
        `/api/scheduled${suffix}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) scheduled = result.messages;
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            error =
              cause instanceof Error ? cause.message : "无法加载定时消息。";
        })
        .finally(() => {
          if (!controller.signal.aborted) loading = false;
        });
    }
    return () => controller.abort();
  });

  $effect(() => {
    const key = currentSearchKey;
    if (observedSearchKey === key) return;
    const initial = observedSearchKey === null;
    observedSearchKey = key;
    searchError = "";
    openingError = "";
    searched = false;
    resultsKey = initial ? key : null;
    searchRevision += 1;
  });

  async function search(more = false) {
    if (
      !store.searchQuery.trim() ||
      store.searchLoading ||
      !store.supports("messages.search")
    )
      return;
    const generation = ++searchRevision;
    const key = currentSearchKey;
    searchError = "";
    searched = true;
    try {
      await store.searchMessages(more);
      if (generation === searchRevision && key === currentSearchKey)
        resultsKey = key;
    } catch (cause) {
      if (generation === searchRevision)
        searchError =
          cause instanceof Error ? cause.message : "搜索失败，请稍后重试。";
    }
  }

  async function open(message: ApiMessage) {
    openingError = "";
    try {
      await store.openResult(message);
    } catch (cause) {
      openingError =
        cause instanceof Error ? cause.message : "无法打开此消息。";
    }
  }

  async function refreshStatus() {
    if (refreshing) return;
    refreshing = true;
    error = "";
    try {
      await store.refreshStatus();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "无法刷新连接状态。";
    } finally {
      refreshing = false;
    }
  }

  function dateTime(value: string | undefined): string {
    if (!value) return "时间未知";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? "时间未知"
      : parsed.toLocaleString("zh-CN", { hour12: false });
  }

  function number(value: number): string {
    return value.toLocaleString("zh-CN");
  }
  function bytes(value: number): string {
    if (value < 1024) return `${number(value)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let scaled = value / 1024;
    let index = 0;
    while (scaled >= 1024 && index < units.length - 1) {
      scaled /= 1024;
      index += 1;
    }
    return `${scaled.toFixed(1)} ${units[index]}`;
  }
  function chatName(id: number, fallback?: string): string {
    return (
      store.chats.find((chat) => chat.id === id)?.display_name ??
      fallback ??
      `对话 ${id}`
    );
  }
</script>

<section
  class="flex min-h-0 min-w-0 flex-1 flex-col bg-white"
  aria-label={title}
>
  <header
    class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3"
  >
    <div class="flex min-w-0 items-center gap-2">
      {#if !store.sidebarOpen}
        <button
          type="button"
          title="返回会话列表"
          aria-label="返回会话列表"
          onclick={() => store.toggleSidebar()}
          class="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100"
          ><PanelLeftOpen size={18} /></button
        >
      {/if}
      <h2 class="font-semibold">{title}</h2>
    </div>
    {#if store.view === "stats" || store.view === "scheduled"}
      <div class="flex min-w-0 items-center gap-2">
        <label for="library-scope" class="sr-only">对话范围</label>
        <select
          id="library-scope"
          bind:value={scope}
          class="max-w-48 min-w-0 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
        >
          <option value={null}>所有对话</option>
          {#each store.chats as chat (chat.id)}<option value={chat.id}
              >{chat.display_name}</option
            >{/each}
        </select>
        <button
          type="button"
          title="刷新当前视图"
          aria-label="刷新当前视图"
          disabled={loading}
          onclick={() => (revision += 1)}
          class="rounded p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
          ><RefreshCw size={16} class={loading ? "animate-spin" : ""} /></button
        >
      </div>
    {:else if store.view === "status"}
      <button
        type="button"
        title="刷新连接状态"
        aria-label="刷新连接状态"
        disabled={refreshing}
        onclick={refreshStatus}
        class="rounded p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
        ><RefreshCw
          size={16}
          class={refreshing ? "animate-spin" : ""}
        /></button
      >
    {/if}
  </header>
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
    {#if store.view === "search"}
      <form
        class="flex flex-wrap items-end gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div class="min-w-0 flex-[1_1_12rem]">
          <label for="library-query" class="mb-1 block text-xs text-gray-500"
            >消息内容</label
          >
          <input
            id="library-query"
            type="search"
            bind:value={store.searchQuery}
            placeholder="搜索消息"
            class="w-full min-w-0 rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
          />
        </div>
        <div class="min-w-0 flex-[1_1_10rem]">
          <label
            for="library-search-scope"
            class="mb-1 block text-xs text-gray-500">对话范围</label
          >
          <select
            id="library-search-scope"
            bind:value={store.searchChatId}
            class="w-full min-w-0 rounded border border-gray-300 bg-white px-2 py-2 text-sm focus:border-blue-400 focus:outline-none"
          >
            <option value={null}>所有对话</option>
            {#each store.chats as chat (chat.id)}<option value={chat.id}
                >{chat.display_name}</option
              >{/each}
          </select>
        </div>
        <span
          title={store.supports("messages.search")
            ? "搜索消息"
            : store.capabilityReason("messages.search")}
        >
          <button
            type="submit"
            title={store.supports("messages.search")
              ? "搜索消息"
              : store.capabilityReason("messages.search")}
            aria-label="搜索消息"
            disabled={store.searchLoading ||
              !store.searchQuery.trim() ||
              !store.supports("messages.search")}
            class="rounded bg-blue-500 p-2.5 text-white disabled:opacity-40"
            ><Search size={18} /></button
          >
        </span>
      </form>
      {#if !store.supports("messages.search")}<p
          role="status"
          class="mt-4 text-sm text-gray-500"
        >
          {store.capabilityReason("messages.search")}
        </p>{/if}
      {#if searchError || store.searchError}<p
          role="alert"
          class="mt-4 break-words text-sm text-red-600"
        >
          {searchError || store.searchError}
        </p>{/if}
      {#if openingError}<p
          role="alert"
          class="mt-4 break-words text-sm text-red-600"
        >
          {openingError}
        </p>{/if}
      {#if store.searchLoading}<p
          role="status"
          class="mt-4 text-sm text-gray-500"
        >
          正在搜索…
        </p>{/if}
      {#if store.searchWarning}<p
          role="status"
          class="mt-4 break-words border-l-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {store.searchWarning}
        </p>{/if}
      {#if results.length > 0}
        <p class="mt-4 text-xs text-gray-500">
          {number(results.length)} 条结果
        </p>
        <ul class="mt-2 divide-y divide-gray-100">
          {#each results as message (`${message.chat_id}:${message.guid}`)}
            <li>
              <button
                type="button"
                title="打开消息所在对话"
                onclick={() => open(message)}
                class="group block w-full min-w-0 rounded px-2 py-3 text-left hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500"
              >
                <div class="flex items-start justify-between gap-2">
                  <p class="min-w-0 break-words text-sm font-medium">
                    {chatName(message.chat_id, message.chat_name)}
                  </p>
                  <ArrowUpRight
                    size={14}
                    class="mt-0.5 shrink-0 text-gray-400 group-hover:text-blue-500"
                  />
                </div>
                <p
                  class="mt-1 break-words whitespace-pre-wrap text-sm text-gray-700"
                >
                  {message.text ||
                    (message.attachments.length ? "附件消息" : "消息")}
                </p>
                <p class="mt-1 break-words text-xs text-gray-500">
                  {message.is_from_me
                    ? "我"
                    : message.sender_name || message.sender} · {dateTime(
                    message.created_at,
                  )}
                </p>
              </button>
            </li>
          {/each}
        </ul>
        {#if store.searchMore}<button
            type="button"
            title="加载更多搜索结果"
            disabled={store.searchLoading}
            onclick={() => search(true)}
            class="mt-4 w-full rounded border border-gray-300 py-2 text-sm text-blue-600 hover:bg-gray-50 disabled:opacity-40"
            >{store.searchLoading ? "加载中…" : "加载更多"}</button
          >{/if}
      {:else if searched && !store.searchLoading && !searchError && !store.searchError}<p
          class="mt-6 text-center text-sm text-gray-500"
        >
          {store.searchWarning
            ? "在全局最新 100 条匹配消息范围内，未找到符合当前会话筛选的消息；更早的消息可能仍有匹配。"
            : "没有找到匹配的消息。"}
        </p>{/if}
    {:else if store.view === "stats"}
      {#if loading}<p role="status" class="text-sm text-gray-500">
          正在加载统计…
        </p>{/if}
      {#if error}<p role="alert" class="break-words text-sm text-red-600">
          {error}
        </p>{/if}
      {#if stats}
        <dl class="grid grid-cols-3 gap-3 border-b border-gray-200 pb-5">
          <div class="min-w-0">
            <dt class="text-xs text-gray-500">全部消息</dt>
            <dd class="mt-1 break-all text-xl font-semibold tabular-nums">
              {number(stats.total_messages)}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-gray-500">已发送</dt>
            <dd
              class="mt-1 break-all text-xl font-semibold text-blue-600 tabular-nums"
            >
              {number(stats.sent_messages)}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-gray-500">已接收</dt>
            <dd
              class="mt-1 break-all text-xl font-semibold text-green-600 tabular-nums"
            >
              {number(stats.received_messages)}
            </dd>
          </div>
        </dl>
        <div class="mt-5 grid gap-6 sm:grid-cols-2">
          <section aria-label="按服务统计">
            <h3 class="mb-2 text-sm font-medium">服务</h3>
            <dl class="space-y-2">
              {#each stats.services as row (row.service)}<div
                  class="flex justify-between gap-3 text-sm"
                >
                  <dt class="min-w-0 break-all text-gray-600">{row.service}</dt>
                  <dd class="shrink-0 tabular-nums">
                    {number(row.message_count)}
                  </dd>
                </div>{/each}
            </dl>
            {#if !stats.services.length}<p class="text-sm text-gray-500">
                暂无消息。
              </p>{/if}
          </section>
          <section aria-label="按日期统计">
            <h3 class="mb-1 text-sm font-medium">日期</h3>
            <p class="mb-2 break-all text-xs text-gray-500">
              时区：{stats.time_zone}
            </p>
            <dl class="max-h-64 space-y-2 overflow-y-auto pr-1">
              {#each [...stats.dates].reverse() as row (row.date)}<div
                  class="flex justify-between gap-3 text-sm"
                >
                  <dt class="text-gray-600">{row.date}</dt>
                  <dd class="tabular-nums">{number(row.message_count)}</dd>
                </div>{/each}
            </dl>
            {#if !stats.dates.length}<p class="text-sm text-gray-500">
                暂无消息。
              </p>{/if}
          </section>
          <section aria-label="按对话统计">
            <h3 class="mb-2 text-sm font-medium">对话</h3>
            <dl class="max-h-64 space-y-2 overflow-y-auto pr-1">
              {#each stats.chats as row (row.chat_id)}<div
                  class="flex justify-between gap-3 text-sm"
                >
                  <dt class="min-w-0 break-words text-gray-600">
                    {chatName(row.chat_id, row.name || row.identifier)}
                  </dt>
                  <dd class="shrink-0 tabular-nums">
                    {number(row.message_count)}
                  </dd>
                </div>{/each}
            </dl>
          </section>
          <section aria-label="按发送者统计">
            <h3 class="mb-2 text-sm font-medium">收到消息的发送者</h3>
            <dl class="max-h-64 space-y-2 overflow-y-auto pr-1">
              {#each stats.senders as row (row.handle)}<div
                  class="flex justify-between gap-3 text-sm"
                >
                  <dt class="min-w-0 break-all text-gray-600">{row.handle}</dt>
                  <dd class="shrink-0 tabular-nums">
                    {number(row.message_count)}
                  </dd>
                </div>{/each}
            </dl>
          </section>
        </div>
        {#if stats.media}
          <section
            class="mt-6 border-t border-gray-200 pt-4"
            aria-label="媒体统计"
          >
            <h3 class="text-sm font-medium">媒体</h3>
            <p class="mt-1 text-sm text-gray-600">
              {number(stats.media.total_attachments)} 个附件 · {bytes(
                stats.media.total_bytes,
              )}
            </p>
            <dl class="mt-3 space-y-2">
              {#each stats.media.types as row (`${row.uti}:${row.mime_type}`)}<div
                  class="flex flex-wrap justify-between gap-2 text-sm"
                >
                  <dt class="min-w-0 break-all text-gray-600">
                    {row.mime_type || row.uti || "未知类型"}
                  </dt>
                  <dd class="tabular-nums">
                    {number(row.attachment_count)} 个 · {bytes(row.total_bytes)}
                  </dd>
                </div>{/each}
            </dl>
          </section>
        {/if}
      {/if}
    {:else if store.view === "scheduled"}
      <p class="mb-4 flex items-center gap-1.5 text-xs text-gray-500">
        <Clock size={13} />原生定时消息 · 只读
      </p>
      {#if loading}<p role="status" class="text-sm text-gray-500">
          正在加载定时消息…
        </p>{/if}
      {#if error}<p role="alert" class="break-words text-sm text-red-600">
          {error}
        </p>{/if}
      {#if !loading && !error && !scheduled.length}<p
          class="py-8 text-center text-sm text-gray-500"
        >
          没有待发送的定时消息。
        </p>{/if}
      <ul class="divide-y divide-gray-100">
        {#each scheduled as message (`${message.chat_id}:${message.guid}`)}
          <li class="py-3">
            <div class="flex flex-wrap justify-between gap-2">
              <h3 class="min-w-0 break-words text-sm font-medium">
                {chatName(
                  message.chat_id,
                  message.chat_name || message.chat_identifier,
                )}
              </h3>
              <span class="text-xs text-gray-500"
                >{message.service ?? "iMessage"}</span
              >
            </div>
            <p
              class="mt-1 break-words whitespace-pre-wrap text-sm text-gray-700"
            >
              {message.text || "无文本内容"}
            </p>
            <p class="mt-2 text-xs text-gray-500">
              计划发送：{dateTime(message.scheduled_at)}
            </p>
          </li>
        {/each}
      </ul>
      {#if !error && scheduled.length >= scheduledLimit}<button
          type="button"
          title="加载更多定时消息"
          disabled={loading || scheduledLimit >= 1000}
          onclick={() =>
            (scheduledLimit = Math.min(1000, scheduledLimit + 100))}
          class="mt-4 w-full rounded border border-gray-300 py-2 text-sm text-blue-600 hover:bg-gray-50 disabled:opacity-40"
          >{scheduledLimit >= 1000 ? "已显示前 1000 条" : "加载更多"}</button
        >{/if}
    {:else if store.view === "status"}
      {#if error || store.statusError}<p
          role="alert"
          class="mb-4 break-words text-sm text-red-600"
        >
          {error || store.statusError}
        </p>{/if}
      {#if !store.status}<p role="status" class="text-sm text-gray-500">
          {refreshing ? "正在读取连接状态…" : "尚未获取连接状态。请刷新。"}
        </p>
      {:else}
        <p class="mb-4 text-sm text-gray-500">
          imsg <span class="font-mono text-gray-800"
            >{store.status.version}</span
          >
        </p>
        <dl class="divide-y divide-gray-100 border-y border-gray-200">
          <div class="flex items-center justify-between gap-3 py-3 text-sm">
            <dt class="flex items-center gap-2">
              <Database size={16} class="text-gray-500" />消息数据库
            </dt>
            <dd
              class={store.status.database.ready
                ? "text-green-700"
                : "text-red-600"}
            >
              {store.status.database.ready ? "可读取" : "不可用"}
            </dd>
          </div>
          <div class="flex items-center justify-between gap-3 py-3 text-sm">
            <dt class="flex items-center gap-2">
              <Plug size={16} class="text-gray-500" />IMCore 桥接
            </dt>
            <dd
              class={store.status.bridge.ready
                ? "text-green-700"
                : "text-amber-700"}
            >
              {store.status.bridge.ready ? "已就绪" : "未就绪"}
            </dd>
          </div>
        </dl>
        {#if !store.status.bridge.ready}<p
            class="mt-2 text-xs leading-relaxed text-gray-500"
          >
            桥接相关写操作不可用。需要在本机明确启动桥接，本页面不会自动启动。
          </p>{/if}
        {#if store.status.database.features}
          <section class="mt-5" aria-label="数据库能力">
            <h3 class="mb-2 text-sm font-medium">数据库能力</h3>
            <dl class="divide-y divide-gray-100">
              {#each Object.entries(store.status.database.features) as [feature, available] (feature)}<div
                  class="flex justify-between gap-3 py-1.5 text-xs"
                >
                  <dt class="min-w-0 break-all font-mono text-gray-600">
                    {feature}
                  </dt>
                  <dd
                    class={available
                      ? "shrink-0 text-green-700"
                      : "shrink-0 text-gray-400"}
                  >
                    {available ? "支持" : "不支持"}
                  </dd>
                </div>{/each}
            </dl>
          </section>
        {/if}
        <section class="mt-5" aria-label="方法能力">
          <h3
            class="mb-2 flex flex-wrap justify-between gap-2 text-sm font-medium"
          >
            <span>方法能力</span><span class="font-normal text-gray-500"
              >{methodNames.filter((method) => store.supports(method)).length} / {methodNames.length}
              可用</span
            >
          </h3>
          <dl class="divide-y divide-gray-100">
            {#each methodNames as method (method)}<div
                class="flex items-start justify-between gap-3 py-2 text-xs"
                title={store.supports(method)
                  ? "当前可用"
                  : store.capabilityReason(method)}
              >
                <dt class="min-w-0 break-all font-mono text-gray-700">
                  {method}
                </dt>
                <dd
                  class={store.supports(method)
                    ? "shrink-0 text-green-700"
                    : "max-w-[55%] text-right text-gray-500"}
                >
                  {store.supports(method)
                    ? "可用"
                    : store.capabilityReason(method)}
                </dd>
              </div>{/each}
          </dl>
        </section>
      {/if}
    {/if}
  </div>
</section>
