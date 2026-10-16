<script lang="ts">
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import PanelLeftClose from "@lucide/svelte/icons/panel-left-close";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import SquarePen from "@lucide/svelte/icons/square-pen";
  import Wifi from "@lucide/svelte/icons/wifi";
  import WifiOff from "@lucide/svelte/icons/wifi-off";
  import ChartColumn from "@lucide/svelte/icons/chart-column";
  import CalendarClock from "@lucide/svelte/icons/calendar-clock";
  import Settings from "@lucide/svelte/icons/settings";
  import { onMount } from "svelte";
  import { auth } from "./auth.svelte";
  import ChatList from "./components/ChatList.svelte";
  import ComposeNew from "./components/ComposeNew.svelte";
  import Conversation from "./components/Conversation.svelte";
  import Login from "./components/Login.svelte";
  import Toasts from "./components/Toasts.svelte";
  import LibraryView from "./components/LibraryView.svelte";
  import { store } from "./store.svelte";

  onMount(() => {
    void store.start();
    return () => store.stop();
  });
</script>

{#if auth.required}
  <Login />
{:else}
  <div class="flex h-dvh overflow-hidden bg-white text-gray-900">
    <aside
      class={`${store.sidebarOpen ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-gray-200 md:w-80`}
    >
      <header
        class="flex items-center justify-between border-b border-gray-200 px-3 py-3"
      >
        <button
          type="button"
          onclick={() => store.toggleSidebar()}
          aria-label="Hide chat list"
          title="Hide chat list"
          class="rounded p-1 text-gray-500 hover:bg-gray-100"
        >
          <PanelLeftClose size={18} />
        </button>
        <span class="flex items-center gap-1">
          <span
            class={store.live ? "text-green-500" : "text-gray-400"}
            title={store.live ? "Live" : "Connecting…"}
          >
            {#if store.live}
              <Wifi size={16} />
            {:else}
              <WifiOff size={16} />
            {/if}
            <span class="sr-only">{store.live ? "live" : "connecting"}</span>
          </span>
          <button
            type="button"
            onclick={() => store.startCompose()}
            aria-label="New message"
            title="New message"
            class="rounded p-1 text-gray-500 hover:bg-gray-100"
          >
            <SquarePen size={18} />
          </button>
        </span>
      </header>
      <ChatList />
      <div
        class="flex items-center justify-between border-t border-gray-200 px-3 py-2"
      >
        <span class="text-xs text-gray-500"
          >imsg {store.status?.version ?? "…"}</span
        >
        <div class="flex gap-1">
          <button
            class="tool"
            aria-label="消息统计"
            title="消息统计"
            onclick={() => store.openView("stats")}
            ><ChartColumn size={17} /></button
          >
          <button
            class="tool"
            aria-label="待发送消息"
            title="待发送消息"
            onclick={() => store.openView("scheduled")}
            ><CalendarClock size={17} /></button
          >
          <button
            class="tool"
            aria-label="服务状态"
            title="服务状态"
            onclick={() => store.openView("status")}
            ><Settings size={17} /></button
          >
        </div>
      </div>
    </aside>
    <section
      class={`${store.sidebarOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col`}
    >
      {#if store.uncertainty}
        <div
          role="alert"
          class="border-b border-red-200 bg-red-50 p-3 text-sm text-red-900"
        >
          <p class="font-medium">
            上次操作可能已执行，请先在“信息”中核对，避免重复发送。
          </p>
          <p class="mt-1 break-words">{store.uncertainty.message}</p>
          {#if store.lastAttemptId}<p class="mt-2 break-all text-xs">
              发送标识：{store.lastAttemptId}
            </p>
            <button
              class="mt-2 rounded border border-red-300 px-3 py-1"
              onclick={() => void store.checkAttempt()}>查询此消息状态</button
            >{#if store.attemptState}<p role="status" class="mt-1 text-xs">
                {store.attemptState}
              </p>{/if}{/if}
          {#if store.uncertainty.blocked}<p class="mt-2">
              操作仍在进行，需先核对并重启服务恢复发送。
            </p>
          {:else}<button
              class="mt-2 rounded-md border border-red-300 px-3 py-1"
              onclick={() => {
                store.uncertainty = null;
              }}>已核对结果，恢复操作</button
            >{/if}
        </div>
      {/if}
      {#if store.view !== "chat"}
        <LibraryView />
      {:else if store.composing}
        <ComposeNew />
      {:else if store.selectedChat}
        <Conversation chat={store.selectedChat} />
      {:else}
        <div
          class="relative flex flex-1 flex-col items-center justify-center gap-3 text-gray-300"
        >
          {#if !store.sidebarOpen}
            <button
              type="button"
              onclick={() => store.toggleSidebar()}
              aria-label="Show chat list"
              title="Show chat list"
              class="absolute top-3 left-3 rounded p-1 text-gray-500 hover:bg-gray-100"
            >
              <PanelLeftOpen size={18} />
            </button>
          {/if}
          <MessagesSquare size={48} strokeWidth={1.25} />
          <p class="text-sm text-gray-400">选择一个会话</p>
        </div>
      {/if}
    </section>
    <Toasts />
  </div>
{/if}
