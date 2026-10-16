<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import UserMinus from "@lucide/svelte/icons/user-minus";
  import Upload from "@lucide/svelte/icons/upload";
  import type { ApiChat } from "../../server/payloads";
  import { request } from "../service";
  import { store } from "../store.svelte";
  import { untrack } from "svelte";

  const { chat }: { chat: ApiChat } = $props();
  const chatId = $derived(chat.id);
  interface ChatMetadata {
    id: number;
    name: string;
    display_name?: string;
    contact_name?: string;
    identifier: string;
    service: string;
    is_group: boolean;
    participants: string[];
    account_id?: string;
    account_login?: string;
    last_addressed_handle?: string;
    unread_count?: number;
  }
  interface Eligibility {
    can_inspect_offer: boolean;
    can_share: boolean;
    should_offer: boolean | null;
  }
  interface Confirmation {
    method: string;
    title: string;
    detail: string;
    params: Record<string, unknown>;
    chatId: number;
    icon?: { file: File | null };
  }

  let panel = $state<HTMLDialogElement | undefined>();
  let metadata = $state<ChatMetadata | null>(null);
  let loading = $state(false);
  let loadError = $state("");
  let error = $state("");
  let notice = $state("");
  let revision = $state(0);
  let busy = $state(false);
  let name = $state("");
  let address = $state("");
  let checks = $state<Record<string, string>>({});
  let checking = $state<string | null>(null);
  let inspecting = $state(false);
  let eligibility = $state<Eligibility | null>(null);
  let photo = $state<File | null>(null);
  let fileInput = $state<HTMLInputElement | undefined>();
  let confirmation = $state<Confirmation | null>(null);
  let contextVersion = 0;
  const blocked = $derived(busy || store.mutationBusy || !!store.uncertainty);
  const details = $derived(metadata?.id === chat.id ? metadata : null);
  const group = $derived(details?.is_group ?? chat.is_group);

  $effect(() => {
    const element = panel;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  });

  $effect(() => {
    void chatId;
    untrack(() => {
      contextVersion += 1;
      metadata = null;
      confirmation = null;
      eligibility = null;
      name = "";
      address = "";
      photo = null;
      checks = {};
      checking = null;
      inspecting = false;
      error = "";
      notice = "";
      if (fileInput) fileInput.value = "";
    });
  });

  $effect(() => {
    const id = chatId;
    void revision;
    const controller = new AbortController();
    loading = true;
    loadError = "";
    void request<ChatMetadata>(`/api/chats/${id}/info`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        metadata = result;
        name = result.display_name ?? result.name ?? "";
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          loadError =
            cause instanceof Error ? cause.message : "无法加载对话详情。";
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => controller.abort();
  });

  function reason(method: string, label: string): string {
    return store.supports(method) ? label : store.capabilityReason(method);
  }

  function close() {
    if (busy) return;
    store.infoOpen = false;
  }

  function ask(
    method: string,
    title: string,
    detail: string,
    params: Record<string, unknown> = {},
  ) {
    if (blocked || !store.supports(method)) return;
    error = "";
    notice = "";
    confirmation = {
      method,
      title,
      detail,
      chatId: chat.id,
      params: { chat_id: chat.id, ...params },
    };
    panel?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function askPhoto(clear: boolean) {
    if (!clear && !photo) return;
    ask(
      "group.setIcon",
      clear ? "清除群头像？" : "更换群头像？",
      "此更改将应用到群聊，所有群成员都可能看到。",
      {},
    );
    if (confirmation) confirmation.icon = { file: clear ? null : photo };
  }

  async function confirm() {
    const action = confirmation;
    if (!action || blocked || !store.supports(action.method)) return;
    busy = true;
    const version = contextVersion;
    error = "";
    notice = "";
    try {
      let result: Record<string, unknown> | null;
      if (action.icon) {
        const form = new FormData();
        form.set("confirmed", "true");
        if (action.icon.file) form.set("file", action.icon.file);
        else form.set("clear", "true");
        result = await store.mutate<Record<string, unknown>>(
          `/api/chats/${action.chatId}/icon`,
          { method: "POST", body: form },
        );
      } else {
        result = await store.runAction(action.method, action.params, true);
      }
      if (chat.id !== action.chatId || contextVersion !== version) return;
      if (!result) {
        error = "操作未确认成功，请先检查对话当前状态，不要直接重复操作。";
        return;
      }
      confirmation = null;
      notice =
        action.method === "contacts.shareContactCard"
          ? "已请求共享姓名与照片；这不代表对方已经收到。"
          : "操作已完成。";
      if (action.icon) {
        photo = null;
        if (fileInput) fileInput.value = "";
      }
      await store.loadChats();
      if (chat.id !== action.chatId || contextVersion !== version) return;
      if (action.method === "chats.delete" || action.method === "group.leave") {
        store.infoOpen = false;
      } else {
        revision += 1;
      }
    } catch (cause) {
      if (chat.id === action.chatId && contextVersion === version) {
        error =
          cause instanceof Error ? cause.message : "操作失败，请检查对话状态。";
      }
    } finally {
      busy = false;
    }
  }

  async function checkAddress(value: string) {
    const target = value.trim();
    if (!target || checking || !store.supports("handles.check")) return;
    const id = chat.id;
    const version = contextVersion;
    checking = target;
    error = "";
    try {
      const result = await store.runAction("handles.check", {
        address: target,
        service: "iMessage",
      });
      if (chat.id !== id || contextVersion !== version) return;
      checks[target] =
        result?.["available"] === true
          ? "iMessage 可达"
          : result?.["available"] === false
            ? "iMessage 不可达"
            : "未能确定可达性";
    } catch (cause) {
      if (chat.id === id && contextVersion === version)
        error = cause instanceof Error ? cause.message : "无法检查此地址。";
    } finally {
      if (chat.id === id && contextVersion === version) checking = null;
    }
  }

  async function inspectSharing() {
    if (inspecting || !store.supports("contacts.shouldShareContact")) return;
    const id = chat.id;
    const version = contextVersion;
    inspecting = true;
    error = "";
    try {
      const result = await store.runAction("contacts.shouldShareContact", {
        chat_id: id,
      });
      if (chat.id !== id || contextVersion !== version) return;
      if (!result) {
        error = "无法检查姓名与照片共享资格。";
        return;
      }
      eligibility = {
        can_inspect_offer: result["can_inspect_offer"] === true,
        can_share: result["can_share"] === true,
        should_offer:
          typeof result["should_offer"] === "boolean"
            ? result["should_offer"]
            : null,
      };
    } catch (cause) {
      if (chat.id === id && contextVersion === version)
        error = cause instanceof Error ? cause.message : "无法检查共享资格。";
    } finally {
      if (chat.id === id && contextVersion === version) inspecting = false;
    }
  }
</script>

<dialog
  bind:this={panel}
  aria-label="对话详情"
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  class="m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-lg border border-gray-200 bg-white p-0 text-gray-900 shadow-xl backdrop:bg-black/30"
>
  <header
    class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-5 py-4"
  >
    <div class="min-w-0">
      <h2 class="font-semibold">对话详情</h2>
      <p class="mt-0.5 truncate text-sm text-gray-500">{chat.display_name}</p>
    </div>
    <div class="flex shrink-0 gap-1">
      <button
        type="button"
        title="刷新对话详情"
        aria-label="刷新对话详情"
        disabled={loading || blocked}
        onclick={() => (revision += 1)}
        class="rounded p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
        ><RefreshCw size={16} class={loading ? "animate-spin" : ""} /></button
      >
      <button
        type="button"
        title="关闭对话详情"
        aria-label="关闭对话详情"
        disabled={busy}
        onclick={close}
        class="rounded p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
        ><X size={18} /></button
      >
    </div>
  </header>
  <div class="space-y-5 p-5 text-sm">
    {#if confirmation}
      <form
        class="rounded-lg border border-red-200 bg-red-50 p-3"
        onsubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <h3 class="font-semibold text-red-800">{confirmation.title}</h3>
        <p class="mt-2 break-words text-red-900">{confirmation.detail}</p>
        {#if confirmation.icon?.file}<p
            class="mt-2 break-all text-xs text-red-800"
          >
            {confirmation.icon.file.name}
          </p>{/if}
        <div class="mt-3 flex justify-end gap-2">
          <button
            type="button"
            title="取消操作"
            disabled={busy}
            onclick={() => (confirmation = null)}
            class="rounded px-3 py-1.5 hover:bg-red-100 disabled:opacity-40"
            >取消</button
          >
          <button
            type="submit"
            title={reason(confirmation.method, "确认操作")}
            disabled={blocked || !store.supports(confirmation.method)}
            class="rounded bg-red-600 px-3 py-1.5 text-white disabled:opacity-40"
            >{busy ? "处理中…" : "确认操作"}</button
          >
        </div>
      </form>
    {/if}
    {#if error}<p role="alert" class="break-words text-red-600">{error}</p>{/if}
    {#if notice}<p role="status" class="text-green-700">{notice}</p>{/if}
    {#if loading}<p role="status" class="text-gray-500">
        正在读取对话详情…
      </p>{/if}
    {#if loadError}<p role="alert" class="break-words text-red-600">
        {loadError}
      </p>{/if}
    {#if details}
      <section aria-label="对话信息">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt class="text-gray-500">服务</dt>
          <dd class="break-all">{details.service}</dd>
          <dt class="text-gray-500">类型</dt>
          <dd>{details.is_group ? "群聊" : "私聊"}</dd>
          {#if details.account_login}<dt class="text-gray-500">账户</dt>
            <dd class="break-all">{details.account_login}</dd>{/if}
          {#if details.account_id}<dt class="text-gray-500">账户标识</dt>
            <dd class="break-all">{details.account_id}</dd>{/if}
          {#if details.last_addressed_handle}<dt class="text-gray-500">
              发送地址
            </dt>
            <dd class="break-all">{details.last_addressed_handle}</dd>{/if}
          {#if details.unread_count !== undefined}<dt class="text-gray-500">
              未读
            </dt>
            <dd>{details.unread_count}</dd>{/if}
        </dl>
      </section>
      <section class="border-t border-gray-200 pt-4" aria-label="对话成员">
        <h3 class="mb-2 font-medium">
          成员 <span class="font-normal text-gray-500"
            >{details.participants.length} 位联系人</span
          >
        </h3>
        {#if details.participants.length === 0}<p class="text-gray-500">
            没有可显示的联系人。
          </p>{/if}
        <ul class="divide-y divide-gray-100">
          {#each details.participants as participant (participant)}
            <li class="flex flex-wrap items-center gap-2 py-2">
              <div class="min-w-0 flex-1">
                <p class="break-all">{participant}</p>
                {#if checks[participant]}<p
                    role="status"
                    class="mt-0.5 text-xs text-gray-500"
                  >
                    {checks[participant]}
                  </p>{/if}
              </div>
              <span title={reason("handles.check", "检查 iMessage 可达性")}>
                <button
                  type="button"
                  title={reason("handles.check", "检查 iMessage 可达性")}
                  aria-label={`检查 ${participant} 的 iMessage 可达性`}
                  disabled={blocked ||
                    checking !== null ||
                    !store.supports("handles.check")}
                  onclick={() => checkAddress(participant)}
                  class="rounded px-2 py-1.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-40"
                  >{checking === participant ? "检查中…" : "检查"}</button
                >
              </span>
              {#if group}
                <span title={reason("group.removeParticipant", "移除此成员")}>
                  <button
                    type="button"
                    title={reason("group.removeParticipant", "移除此成员")}
                    aria-label={`移除成员 ${participant}`}
                    disabled={blocked ||
                      !store.supports("group.removeParticipant")}
                    onclick={() =>
                      ask(
                        "group.removeParticipant",
                        "移除群成员？",
                        `将 ${participant} 从此群聊移除。其他成员可能看到此变更。`,
                        { address: participant },
                      )}
                    class="rounded p-2 text-red-600 hover:bg-red-50 disabled:opacity-40"
                    ><UserMinus size={14} /></button
                  >
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    <section class="border-t border-gray-200 pt-4" aria-label="阅读状态">
      <h3 class="mb-2 font-medium">阅读状态</h3>
      <div class="flex flex-wrap gap-2">
        <span title={reason("read", "标记为已读，可能发送已读回执")}
          ><button
            type="button"
            title={reason("read", "标记为已读，可能发送已读回执")}
            disabled={blocked || !store.supports("read")}
            onclick={() =>
              ask(
                "read",
                "标记为已读？",
                "将此对话标记为已读。如果已启用已读回执，对方可能收到回执。 ",
              )}
            class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
            >标记已读</button
          ></span
        >
        <span title={reason("chats.markUnread", "标记为未读")}
          ><button
            type="button"
            title={reason("chats.markUnread", "标记为未读")}
            disabled={blocked || !store.supports("chats.markUnread")}
            onclick={() =>
              ask(
                "chats.markUnread",
                "标记为未读？",
                "将此对话在 Messages 中标记为未读。此操作不会撤销已发送的回执。 ",
              )}
            class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
            >标记未读</button
          ></span
        >
      </div>
    </section>
    {#if group}
      <section
        class="space-y-4 border-t border-gray-200 pt-4"
        aria-label="群设置"
      >
        <h3 class="font-medium">群设置</h3>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            ask(
              "group.rename",
              "更改群名称？",
              `群名称将更改为「${name.trim()}」。所有成员可能看到此变更。`,
              { name: name.trim() },
            );
          }}
        >
          <label for="chat-details-name" class="mb-1 block text-gray-600"
            >群名称</label
          >
          <div class="flex gap-2">
            <input
              id="chat-details-name"
              bind:value={name}
              disabled={blocked || !details}
              class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1.5 focus:border-blue-400 focus:outline-none"
            />
            <span title={reason("group.rename", "更改群名称")}
              ><button
                type="submit"
                title={reason("group.rename", "更改群名称")}
                disabled={blocked ||
                  !details ||
                  !name.trim() ||
                  !store.supports("group.rename")}
                class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
                >更改</button
              ></span
            >
          </div>
        </form>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            if (address.trim())
              ask(
                "group.addParticipant",
                "添加群成员？",
                `将邀请 ${address.trim()} 加入此群聊。`,
                { address: address.trim() },
              );
          }}
        >
          <label for="chat-details-address" class="mb-1 block text-gray-600"
            >添加成员的电话号码或邮箱</label
          >
          <input
            id="chat-details-address"
            type="text"
            bind:value={address}
            disabled={blocked}
            class="w-full min-w-0 rounded border border-gray-300 px-2 py-1.5 focus:border-blue-400 focus:outline-none"
          />
          {#if checks[address.trim()]}<p
              role="status"
              class="mt-1 text-xs text-gray-500"
            >
              {checks[address.trim()]}
            </p>{/if}
          <div class="mt-2 flex justify-end gap-2">
            <span title={reason("handles.check", "检查 iMessage 可达性")}
              ><button
                type="button"
                title={reason("handles.check", "检查 iMessage 可达性")}
                disabled={blocked ||
                  !address.trim() ||
                  checking !== null ||
                  !store.supports("handles.check")}
                onclick={() => checkAddress(address)}
                class="rounded px-3 py-1.5 text-blue-600 hover:bg-blue-50 disabled:opacity-40"
                >检查地址</button
              ></span
            >
            <span title={reason("group.addParticipant", "添加群成员")}
              ><button
                type="submit"
                title={reason("group.addParticipant", "添加群成员")}
                disabled={blocked ||
                  !address.trim() ||
                  !store.supports("group.addParticipant")}
                class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
                >添加成员</button
              ></span
            >
          </div>
        </form>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            askPhoto(false);
          }}
        >
          <label for="chat-details-photo" class="mb-1 block text-gray-600"
            >群头像</label
          >
          <input
            bind:this={fileInput}
            id="chat-details-photo"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif"
            disabled={blocked || !store.supports("group.setIcon")}
            title={reason("group.setIcon", "选择群头像图片")}
            onchange={(event) =>
              (photo = event.currentTarget.files?.[0] ?? null)}
            class="block w-full min-w-0 text-xs text-gray-600 file:mr-2 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-gray-700 disabled:opacity-40"
          />
          <div class="mt-2 flex flex-wrap justify-end gap-2">
            <span title={reason("group.setIcon", "清除群头像")}
              ><button
                type="button"
                title={reason("group.setIcon", "清除群头像")}
                disabled={blocked || !store.supports("group.setIcon")}
                onclick={() => askPhoto(true)}
                class="rounded px-3 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
                >清除头像</button
              ></span
            >
            <span title={reason("group.setIcon", "上传群头像")}
              ><button
                type="submit"
                title={reason("group.setIcon", "上传群头像")}
                disabled={blocked || !photo || !store.supports("group.setIcon")}
                class="flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
                ><Upload size={14} />上传头像</button
              ></span
            >
          </div>
        </form>
      </section>
    {/if}
    <section class="border-t border-gray-200 pt-4" aria-label="姓名与照片共享">
      <h3 class="font-medium">姓名与照片</h3>
      <p class="mt-1 text-xs leading-relaxed text-gray-500">
        共享会向此对话的所有成员披露你的 Messages
        姓名与照片，不是发送联系人名片。
      </p>
      {#if eligibility}<p role="status" class="mt-2 text-xs text-gray-600">
          {eligibility.can_share ? "当前可请求共享。" : "当前无法共享。"}
          {eligibility.can_inspect_offer
            ? eligibility.should_offer === true
              ? "Messages 建议共享。"
              : eligibility.should_offer === false
                ? "Messages 未建议共享。"
                : "共享建议未知。"
            : "无法读取 Messages 的共享建议。"}
        </p>{/if}
      <div class="mt-3 flex flex-wrap gap-2">
        <span title={reason("contacts.shouldShareContact", "检查共享资格")}
          ><button
            type="button"
            title={reason("contacts.shouldShareContact", "检查共享资格")}
            disabled={blocked ||
              inspecting ||
              !store.supports("contacts.shouldShareContact")}
            onclick={inspectSharing}
            class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
            >{inspecting ? "检查中…" : "检查共享资格"}</button
          ></span
        >
        <span
          title={!store.supports("contacts.shareContactCard")
            ? store.capabilityReason("contacts.shareContactCard")
            : eligibility?.can_share
              ? "共享姓名与照片"
              : "请先检查共享资格"}
          ><button
            type="button"
            title={!store.supports("contacts.shareContactCard")
              ? store.capabilityReason("contacts.shareContactCard")
              : "需先检查共享资格并确认"}
            disabled={blocked ||
              !eligibility?.can_share ||
              !store.supports("contacts.shareContactCard")}
            onclick={() =>
              ask(
                "contacts.shareContactCard",
                "共享你的姓名与照片？",
                "将向此对话的所有成员共享你当前的 Messages 姓名与照片。此操作不会发送 vCard；成功仅表示共享请求已提交。 ",
              )}
            class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40"
            >共享姓名与照片</button
          ></span
        >
      </div>
    </section>
    <section
      class="flex flex-wrap gap-2 border-t border-gray-200 pt-4"
      aria-label="对话管理"
    >
      {#if group}<span title={reason("group.leave", "退出群聊")}
          ><button
            type="button"
            title={reason("group.leave", "退出群聊")}
            disabled={blocked || !store.supports("group.leave")}
            onclick={() =>
              ask(
                "group.leave",
                "退出此群聊？",
                `将退出「${chat.display_name}」。退出后将无法继续接收此群的新消息，重新加入需要其他成员邀请。`,
              )}
            class="rounded border border-red-200 px-3 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
            >退出群聊</button
          ></span
        >{/if}
      <span title={reason("chats.delete", "删除对话")}
        ><button
          type="button"
          title={reason("chats.delete", "删除对话")}
          disabled={blocked || !store.supports("chats.delete")}
          onclick={() =>
            ask(
              "chats.delete",
              "删除整个对话？",
              `将请求从本机 Messages 删除「${chat.display_name}」及其消息记录。这不会删除其他成员的副本，本机删除可能同步到你的其他设备。`,
            )}
          class="rounded border border-red-200 px-3 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"
          >删除对话</button
        ></span
      >
    </section>
  </div>
</dialog>
