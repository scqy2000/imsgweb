<script lang="ts">
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Search from "@lucide/svelte/icons/search";
  import ListFilter from "@lucide/svelte/icons/list-filter";
  import Users from "@lucide/svelte/icons/users";
  import { shortTime } from "../format";
  import { store } from "../store.svelte";
</script>

<div class="space-y-2 border-b border-gray-200 p-3">
  <label
    class="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5"
  >
    <Search size={16} class="shrink-0 text-gray-400" />
    <input
      aria-label="筛选会话"
      placeholder="筛选会话"
      bind:value={store.chatQuery}
      class="min-w-0 flex-1 text-sm outline-none"
    />
  </label>
  <form
    class="flex gap-1"
    onsubmit={(event) => {
      event.preventDefault();
      void store.searchMessages();
    }}
  >
    <input
      aria-label="搜索消息"
      placeholder="搜索所有消息"
      bind:value={store.searchQuery}
      class="min-w-0 flex-1 rounded-md border border-gray-200 px-2 py-1.5 text-sm"
    />
    <button
      aria-label="搜索消息"
      title={store.capabilityReason("messages.search") || "搜索消息"}
      disabled={!store.supports("messages.search") || !store.searchQuery.trim()}
      class="tool"
      type="submit"><Search size={16} /></button
    >
  </form>
  <button
    class={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${store.unreadOnly ? "bg-blue-100 text-blue-700" : "text-gray-500"}`}
    aria-pressed={store.unreadOnly}
    disabled={!store.status?.database.features?.["unread_state"]}
    title={store.status?.database.features?.["unread_state"]
      ? "只显示未读会话"
      : "数据库未提供未读状态"}
    onclick={() => {
      store.unreadOnly = !store.unreadOnly;
      void store.loadChats();
    }}><ListFilter size={14} />未读</button
  >
</div>
<nav aria-label="会话列表" class="min-h-0 flex-1 overflow-y-auto">
  {#each store.visibleChats as chat (chat.id)}
    <button
      type="button"
      onclick={() => void store.select(chat.id)}
      class={`flex w-full flex-col gap-0.5 border-b border-gray-100 px-4 py-3 text-left hover:bg-gray-50 ${
        chat.id === store.selectedChatId ? "bg-blue-50" : ""
      }`}
    >
      <span class="flex items-baseline justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5 font-medium">
          <span class="truncate">{chat.display_name}</span>
          {#if chat.is_group}
            <span class="shrink-0 text-gray-400" title="Group chat">
              <Users size={14} />
              <span class="sr-only">group</span>
            </span>
          {/if}
        </span>
        <span class="shrink-0 text-xs text-gray-400">
          {shortTime(chat.last_message_at)}
          {#if (chat.unread_count ?? 0) > 0}<span
              class="ml-1 inline-flex min-w-5 justify-center rounded-full bg-blue-600 px-1 text-[11px] text-white"
              aria-label={`${chat.unread_count} 条未读`}
              >{chat.unread_count}</span
            >{/if}
        </span>
      </span>
      {#if chat.last_message}
        <span class="truncate text-sm text-gray-500">
          {chat.last_message.is_from_me ? "You: " : ""}{chat.last_message.text}
        </span>
      {/if}
    </button>
  {/each}
  {#if store.chatsLoading}
    <div class="flex justify-center py-8 text-gray-400">
      <LoaderCircle size={20} class="animate-spin" />
      <span class="sr-only">Loading chats</span>
    </div>
  {:else if store.visibleChats.length === 0}
    <p class="px-4 py-6 text-center text-sm text-gray-400">没有匹配的会话</p>
  {/if}
  {#if store.moreChats}<button
      class="w-full py-3 text-sm text-blue-600 disabled:opacity-50"
      disabled={store.chatsLoading}
      onclick={() => void store.loadChats(true)}>加载更多会话</button
    >{/if}
</nav>
