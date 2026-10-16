<script lang="ts">
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Reply from "@lucide/svelte/icons/reply";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import BellRing from "@lucide/svelte/icons/bell-ring";
  import X from "@lucide/svelte/icons/x";
  import type { ApiMessage } from "../../server/payloads";
  import { store } from "../store.svelte";
  import { untrack } from "svelte";

  const { message }: { message: ApiMessage } = $props();
  const messageGuid = $derived(message.guid);
  const reactions = [
    { kind: "love", stored: "love", symbol: "♥", label: "喜爱" },
    { kind: "like", stored: "like", symbol: "👍", label: "赞" },
    { kind: "dislike", stored: "dislike", symbol: "👎", label: "不赞同" },
    { kind: "laugh", stored: "laugh", symbol: "哈哈", label: "大笑" },
    { kind: "emphasize", stored: "emphasis", symbol: "!!", label: "强调" },
    { kind: "question", stored: "question", symbol: "?", label: "疑问" },
  ] as const;
  type Confirmation = {
    method: string;
    title: string;
    detail: string;
    chatId: number;
    guid: string;
  };

  let menu = $state<HTMLDetailsElement | undefined>();
  let dialog = $state<HTMLDialogElement | undefined>();
  let confirmation = $state<Confirmation | null>(null);
  let editing = $state(false);
  let editedText = $state("");
  let busy = $state(false);
  let error = $state("");
  const blocked = $derived(busy || store.mutationBusy || !!store.uncertainty);

  $effect(() => {
    void messageGuid;
    untrack(() => {
      editing = false;
      editedText = "";
      error = "";
      confirmation = null;
      dialog?.close();
      if (menu) menu.open = false;
    });
  });

  function reason(method: string, label: string): string {
    return store.supports(method) ? label : store.capabilityReason(method);
  }

  function ownsReaction(kind: string): boolean {
    return message.reactions.some(
      (item) => item.is_from_me && item.type === kind,
    );
  }

  async function mutate(
    method: string,
    params: Record<string, unknown>,
    chatId: number,
    confirmed = false,
  ): Promise<boolean> {
    if (blocked || !store.supports(method)) return false;
    busy = true;
    error = "";
    const target = message.guid;
    try {
      const result = await store.runAction(method, params, confirmed);
      if (!result) {
        if (message.guid === target)
          error = "操作未确认成功，请先检查最新消息状态，不要直接重复操作。";
        return false;
      }
      await store.loadHistory(chatId);
      if (message.guid === target && menu) menu.open = false;
      return true;
    } catch (cause) {
      if (message.guid === target)
        error =
          cause instanceof Error ? cause.message : "操作失败，请检查消息状态。";
      return false;
    } finally {
      busy = false;
    }
  }

  async function react(kind: string, stored: string) {
    const target = message;
    await mutate(
      "tapback",
      {
        chat_id: target.chat_id,
        message_guid: target.guid,
        reaction: kind,
        remove: ownsReaction(stored),
      },
      target.chat_id,
    );
  }

  function ask(method: string, title: string, detail: string) {
    if (blocked || !store.supports(method)) return;
    confirmation = {
      method,
      title,
      detail,
      chatId: message.chat_id,
      guid: message.guid,
    };
    dialog?.showModal();
  }

  function cancel() {
    if (busy) return;
    dialog?.close();
    confirmation = null;
  }

  async function confirm() {
    const action = confirmation;
    if (!action || blocked) return;
    const ok = await mutate(
      action.method,
      {
        chat_id: action.chatId,
        message_guid: action.guid,
      },
      action.chatId,
      true,
    );
    if (ok) {
      dialog?.close();
      confirmation = null;
    }
  }

  async function saveEdit() {
    const target = message;
    if (!editedText.trim()) return;
    const ok = await mutate(
      "message.edit",
      {
        chat_id: target.chat_id,
        message_guid: target.guid,
        text: editedText,
      },
      target.chat_id,
      true,
    );
    if (ok && message.guid === target.guid) editing = false;
  }
</script>

<details
  bind:this={menu}
  class="message-actions mt-0.5 max-w-full text-xs text-gray-500"
>
  <summary
    class="inline-flex cursor-pointer list-none items-center rounded p-1 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
    aria-label="消息操作"
    title="消息操作"><Ellipsis size={16} /></summary
  >
  <div
    class="mt-1 max-w-full rounded-lg border border-gray-200 bg-white p-2 text-gray-800 shadow-sm"
  >
    <div
      class="flex flex-wrap items-center gap-1"
      aria-label="回应消息"
      role="group"
    >
      {#each reactions as reaction (reaction.kind)}
        <span
          title={reason(
            "tapback",
            `${ownsReaction(reaction.stored) ? "移除" : "添加"}${reaction.label}回应`,
          )}
        >
          <button
            type="button"
            aria-label={`${ownsReaction(reaction.stored) ? "移除" : "添加"}${reaction.label}回应`}
            aria-pressed={ownsReaction(reaction.stored)}
            title={reason("tapback", reaction.label)}
            disabled={blocked || !store.supports("tapback")}
            onclick={() => react(reaction.kind, reaction.stored)}
            class={`min-h-8 min-w-8 rounded px-1.5 text-sm hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 ${ownsReaction(reaction.stored) ? "bg-blue-50 text-blue-700 ring-1 ring-blue-300" : ""}`}
            >{reaction.symbol}</button
          >
        </span>
      {/each}
    </div>
    <div class="mt-2 flex flex-wrap gap-1 border-t border-gray-100 pt-2">
      <span title={reason("send.rich", "回复此消息")}>
        <button
          type="button"
          title={reason("send.rich", "回复此消息")}
          disabled={blocked || !store.supports("send.rich")}
          class="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-gray-100 disabled:opacity-40"
          onclick={() => {
            store.replyTo = message;
            if (menu) menu.open = false;
          }}><Reply size={13} />回复</button
        >
      </span>
      {#if message.is_from_me}
        <span title={reason("message.edit", "编辑消息")}>
          <button
            type="button"
            title={reason("message.edit", "编辑消息")}
            disabled={blocked || !store.supports("message.edit")}
            class="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-gray-100 disabled:opacity-40"
            onclick={() => {
              editedText = message.text;
              editing = true;
            }}><Pencil size={13} />编辑</button
          >
        </span>
        <span title={reason("message.unsend", "撤回消息")}>
          <button
            type="button"
            title={reason("message.unsend", "撤回消息")}
            disabled={blocked || !store.supports("message.unsend")}
            class="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-gray-100 disabled:opacity-40"
            onclick={() =>
              ask(
                "message.unsend",
                "撤回这条消息？",
                "将请求从对话中撤回此消息。能否撤回取决于发送时间、服务与对方系统版本，对方可能已经看到消息。",
              )}><Undo2 size={13} />撤回</button
          >
        </span>
        <span title={reason("message.notifyAnyways", "仍然通知对方")}>
          <button
            type="button"
            title={reason("message.notifyAnyways", "仍然通知对方")}
            disabled={blocked || !store.supports("message.notifyAnyways")}
            class="flex items-center gap-1 rounded px-2 py-1.5 hover:bg-gray-100 disabled:opacity-40"
            onclick={() =>
              ask(
                "message.notifyAnyways",
                "仍然通知对方？",
                "将针对这条消息请求仍然通知，可能打断对方的专注模式。",
              )}><BellRing size={13} />仍然通知</button
          >
        </span>
      {/if}
      <span title={reason("message.delete", "删除消息")}>
        <button
          type="button"
          title={reason("message.delete", "删除消息")}
          disabled={blocked || !store.supports("message.delete")}
          class="flex items-center gap-1 rounded px-2 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
          onclick={() =>
            ask(
              "message.delete",
              "删除这条消息？",
              "将请求从本机 Messages 中删除此消息。这不是撤回，不会删除对方的副本；本机删除可能同步到你的其他设备。",
            )}><Trash2 size={13} />删除</button
        >
      </span>
    </div>
    {#if editing}
      <form
        class="mt-2 space-y-2 border-t border-gray-100 pt-2"
        onsubmit={(event) => {
          event.preventDefault();
          void saveEdit();
        }}
      >
        <label class="block" for={`edit-message-${message.id}`}>编辑消息</label>
        <textarea
          id={`edit-message-${message.id}`}
          rows="3"
          bind:value={editedText}
          disabled={blocked}
          class="block w-full min-w-0 resize-y rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
        ></textarea>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            title="取消编辑"
            disabled={busy}
            onclick={() => (editing = false)}
            class="rounded px-2 py-1.5 hover:bg-gray-100">取消</button
          >
          <button
            type="submit"
            title={reason("message.edit", "保存编辑")}
            disabled={blocked ||
              !editedText.trim() ||
              !store.supports("message.edit")}
            class="rounded bg-blue-500 px-3 py-1.5 text-white disabled:opacity-40"
            >保存</button
          >
        </div>
      </form>
    {/if}
  </div>
</details>
{#if error}<p
    role="alert"
    class="mt-1 max-w-full break-words text-xs text-red-600"
  >
    {error}
  </p>{/if}

<dialog
  bind:this={dialog}
  aria-label={confirmation?.title ?? "确认消息操作"}
  oncancel={(event) => {
    event.preventDefault();
    cancel();
  }}
  class="m-auto w-[calc(100%-2rem)] max-w-sm rounded-lg border border-gray-200 bg-white p-5 text-gray-900 shadow-xl backdrop:bg-black/30"
>
  {#if confirmation}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <div class="flex items-start justify-between gap-3">
        <h3 class="font-semibold">{confirmation.title}</h3>
        <button
          type="button"
          onclick={cancel}
          disabled={busy}
          title="取消操作"
          aria-label="取消操作"
          class="rounded p-1 text-gray-500 hover:bg-gray-100"
          ><X size={16} /></button
        >
      </div>
      <p class="mt-3 text-sm leading-relaxed text-gray-600">
        {confirmation.detail}
      </p>
      <p
        class="mt-2 max-h-24 overflow-y-auto break-words whitespace-pre-wrap text-sm text-gray-500"
      >
        {message.text || "附件消息"}
      </p>
      {#if error}<p role="alert" class="mt-3 text-sm text-red-600">
          {error}
        </p>{/if}
      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onclick={cancel}
          disabled={busy}
          title="取消操作"
          class="rounded px-3 py-2 text-sm hover:bg-gray-100">取消</button
        >
        <button
          type="submit"
          disabled={blocked || !store.supports(confirmation.method)}
          title={reason(confirmation.method, "确认操作")}
          class="rounded bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-40"
          >{busy ? "处理中…" : "确认操作"}</button
        >
      </div>
    </form>
  {/if}
</dialog>

<style>
  summary::-webkit-details-marker {
    display: none;
  }
</style>
