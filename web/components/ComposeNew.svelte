<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import PanelLeftOpen from "@lucide/svelte/icons/panel-left-open";
  import X from "@lucide/svelte/icons/x";
  import { store } from "../store.svelte";
  let to = $state("");
  let text = $state("");
  let name = $state("");
  let group = $state(false);
  let service = $state("auto");
  let allowSms = $state(false);
  let sending = $state(false);
  let reachable = $state<string | null>(null);
  const addresses = $derived(
    to
      .split(/[;,\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const canSend = $derived(
    !sending &&
      !store.mutationBusy &&
      !store.uncertainty &&
      (group
        ? store.supports("chats.create") && addresses.length >= 2
        : store.supports("send") && to.trim() !== "" && text.trim() !== ""),
  );
  async function submit() {
    if (!canSend) return;
    sending = true;
    try {
      if (group) {
        const result = await store.runAction("chats.create", {
          addresses,
          service: "iMessage",
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(text.trim() ? { text: text.trim() } : {}),
        });
        if (result) {
          await store.loadChats();
          const chat = store.chats.find((c) => c.guid === result["chat_guid"]);
          if (chat) await store.select(chat.id);
          else store.cancelCompose();
        }
      } else await store.compose(to.trim(), text.trim(), service, allowSms);
    } finally {
      sending = false;
    }
  }
  async function checkRecipient() {
    reachable = null;
    const result = await store.runAction("handles.check", {
      address: to.trim(),
    });
    if (result)
      reachable =
        result["available"] === true
          ? "此地址可使用 iMessage"
          : "此地址当前不可使用 iMessage";
  }
</script>

<header class="flex items-center gap-2 border-b border-gray-200 p-3">
  {#if !store.sidebarOpen}<button
      class="tool"
      aria-label="显示会话列表"
      title="显示会话列表"
      onclick={() => store.toggleSidebar()}><PanelLeftOpen size={18} /></button
    >{/if}
  <h2 class="flex-1 font-semibold">{group ? "新建群聊" : "新消息"}</h2>
  <button
    class="tool"
    aria-label="取消"
    title="取消"
    onclick={() => store.cancelCompose()}><X size={18} /></button
  >
</header>
<div class="space-y-3 border-b border-gray-200 p-4 text-sm">
  <div class="flex gap-2" role="group" aria-label="会话类型">
    <button
      class={`rounded-md border px-3 py-1 ${!group ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200"}`}
      aria-pressed={!group}
      onclick={() => {
        group = false;
      }}>单聊</button
    >
    <button
      class={`rounded-md border px-3 py-1 ${group ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200"}`}
      aria-pressed={group}
      title={store.capabilityReason("chats.create")}
      disabled={!store.supports("chats.create")}
      onclick={() => {
        group = true;
      }}>群聊</button
    >
  </div>
  <label class="flex items-center gap-2"
    ><span class="shrink-0 text-gray-500">{group ? "成员" : "收件人"}</span
    ><input
      aria-label="收件人"
      bind:value={to}
      placeholder={group ? "号码或邮箱，以逗号分隔" : "号码或邮箱"}
      class="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2"
    /></label
  >
  {#if group}<label class="flex items-center gap-2"
      ><span class="shrink-0 text-gray-500">群名称</span><input
        aria-label="群名称"
        bind:value={name}
        class="min-w-0 flex-1 rounded-md border border-gray-200 px-3 py-2"
      /></label
    >
  {:else}
    <div class="flex flex-wrap items-center gap-3">
      <label
        >服务 <select
          aria-label="发送服务"
          bind:value={service}
          class="rounded border border-gray-200 p-1"
          ><option value="auto">自动</option><option value="imessage"
            >iMessage</option
          ><option value="sms">SMS</option></select
        ></label
      >
      <label class="flex gap-1"
        ><input type="checkbox" bind:checked={allowSms} />允许短信回退</label
      >
      <button
        disabled={!store.supports("handles.check") ||
          !to.trim() ||
          store.mutationBusy}
        title={store.capabilityReason("handles.check")}
        class="text-blue-600 disabled:text-gray-400"
        onclick={() => void checkRecipient()}>检查 iMessage</button
      >
    </div>
  {/if}
  {#if reachable}<p role="status" class="text-gray-500">{reachable}</p>{/if}
</div>
<div class="min-h-0 flex-1"></div>
<footer class="border-t border-gray-200 p-3">
  <form
    class="flex items-end gap-2"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <textarea
      aria-label="新消息正文"
      placeholder={group ? "首条消息（可选）" : "消息正文"}
      rows="2"
      bind:value={text}
      disabled={sending}
      class="min-w-0 flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2"
      onkeydown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void submit();
        }
      }}
    ></textarea>
    <button
      type="submit"
      aria-label={group ? "创建群聊" : "Send"}
      title={group ? "创建群聊" : "发送"}
      disabled={!canSend}
      class="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-40"
      ><ArrowUp size={18} /></button
    >
  </form>
</footer>
