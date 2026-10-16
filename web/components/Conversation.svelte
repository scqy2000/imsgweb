<script lang="ts">
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import Info from "@lucide/svelte/icons/info";
  import Search from "@lucide/svelte/icons/search";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { ApiChat } from "../../server/payloads";
  import { store } from "../store.svelte";
  import Composer from "./Composer.svelte";
  import MessageList from "./MessageList.svelte";
  import ChatDetails from "./ChatDetails.svelte";

  const { chat }: { chat: ApiChat } = $props();
</script>

<header class="flex items-center gap-2 border-b border-gray-200 px-3 py-3">
  {#if !store.sidebarOpen}
    <button
      type="button"
      onclick={() => store.toggleSidebar()}
      aria-label="Show chat list"
      title="Show chat list"
      class="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100"
    >
      <PanelLeftOpen size={18} />
    </button>
  {/if}
  <div class="min-w-0 flex-1">
    <h2 class="truncate font-semibold">{chat.display_name}</h2>
    {#if chat.is_group}
      <p class="truncate text-xs text-gray-500">
        {chat.participants.join(", ")}
      </p>
    {/if}
  </div>
  <button
    class="tool"
    aria-label="搜索此会话"
    title="搜索此会话"
    onclick={() => {
      store.searchChatId = chat.id;
      store.openView("search");
    }}><Search size={17} /></button
  >
  <button
    class="tool"
    aria-label="刷新消息"
    title="刷新消息"
    onclick={() => void store.latest()}><RefreshCw size={17} /></button
  >
  <button
    class="tool"
    aria-label="会话详情"
    title="会话详情"
    onclick={() => {
      store.infoOpen = !store.infoOpen;
    }}><Info size={17} /></button
  >
</header>
{#if store.focusedResult}<button
    class="border-b border-blue-100 bg-blue-50 py-2 text-sm text-blue-700"
    onclick={() => void store.latest()}>返回最新消息</button
  >{/if}
{#key chat.id}
  <MessageList
    chatId={chat.id}
    isGroup={chat.is_group}
    isSms={chat.service.toLowerCase() !== "imessage"}
  />
{/key}
{#key chat.id}<Composer />{/key}
{#if store.infoOpen}<ChatDetails {chat} />{/if}
