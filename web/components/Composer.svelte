<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import X from "@lucide/svelte/icons/x";
  import Bold from "@lucide/svelte/icons/bold";
  import Italic from "@lucide/svelte/icons/italic";
  import Underline from "@lucide/svelte/icons/underline";
  import Strikethrough from "@lucide/svelte/icons/strikethrough";
  import { onDestroy } from "svelte";
  import { store, type SendInput } from "../store.svelte";

  let text = $state("");
  let file = $state<File | null>(null);
  let sending = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let advanced = $state(false);
  let mode = $state<NonNullable<SendInput["mode"]> | "poll">("standard");
  let service = $state("auto");
  let allowSms = $state(false);
  let subject = $state("");
  let effect = $state("");
  let styles = $state<string[]>([]);
  let options = $state("");
  let typingEnabled = $state(false);
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTyping = 0;
  const chatId = store.selectedChatId;
  const isSms = $derived(
    store.selectedChat?.service.toLowerCase() !== "imessage",
  );
  const method = $derived(
    mode === "poll"
      ? "poll.send"
      : mode === "audio"
        ? "send.attachment"
        : mode === "sticker"
          ? "send.sticker"
          : mode === "multipart"
            ? "send.multipart"
            : mode === "url" || mode === "rich"
              ? "send.rich"
              : mode === "tracked"
                ? "send.tracked"
                : "send",
  );
  const selectedMethod = $derived(
    (store.replyTo && mode === "standard") || subject || effect || styles.length
      ? "send.rich"
      : method,
  );
  const replyCompatible = $derived(
    !store.replyTo || ["standard", "rich", "audio"].includes(mode),
  );
  const pollOptions = $derived(
    options
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const canSend = $derived(
    !sending &&
      !store.mutationBusy &&
      !store.uncertainty &&
      store.supports(selectedMethod) &&
      replyCompatible &&
      (mode === "poll"
        ? text.trim() !== "" && pollOptions.length >= 2
        : mode === "audio" || mode === "sticker"
          ? file !== null
          : text.trim() !== "" || file !== null),
  );

  function stopTyping() {
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = null;
    if (typingEnabled && chatId !== null && store.supports("typing"))
      void store.runAction("typing", { chat_id: chatId, typing: false });
  }
  onDestroy(stopTyping);
  function onInput() {
    if (!typingEnabled || !store.supports("typing") || chatId === null) return;
    if (typingTimer) clearTimeout(typingTimer);
    if (Date.now() - lastTyping > 4000 && text.trim()) {
      lastTyping = Date.now();
      void store.runAction("typing", { chat_id: chatId, typing: true });
    }
    typingTimer = setTimeout(stopTyping, 5000);
  }
  function toggleStyle(style: string) {
    styles = styles.includes(style)
      ? styles.filter((s) => s !== style)
      : [...styles, style];
  }
  async function submit() {
    if (!canSend) return;
    sending = true;
    try {
      let ok: boolean;
      if (mode === "poll") {
        ok = !!(await store.runAction("poll.send", {
          chat_id: chatId,
          question: text.trim(),
          options: pollOptions,
        }));
      } else {
        const input: SendInput = {
          mode,
          service,
          allow_sms_fallback: allowSms,
        };
        if (mode === "tracked") input.attempt_id = crypto.randomUUID();
        if (mode === "url") input.url = text.trim();
        else if (mode === "multipart")
          input.parts = text
            .split(/\n\s*\n/)
            .map((s) => ({ text: s.trim() }))
            .filter((s) => s.text);
        else if (mode !== "audio" && mode !== "sticker" && text.trim())
          input.text = text.trim();
        if (file) input.file = file;
        if (store.replyTo) input.reply_to = store.replyTo.guid;
        if (subject) input.subject = subject;
        if (effect) input.effect_id = effect;
        if (styles.length && input.text)
          input.text_formatting = [
            { start: 0, length: input.text.length, styles },
          ];
        if (
          (store.replyTo && mode === "standard") ||
          subject ||
          effect ||
          styles.length
        )
          input.mode = "rich";
        ok = await store.send(input);
      }
      if (ok) {
        text = "";
        file = null;
        options = "";
        if (fileInput) fileInput.value = "";
      }
    } finally {
      sending = false;
    }
  }
</script>

<footer class="shrink-0 border-t border-gray-200 px-3 py-2 sm:px-4">
  {#if store.replyTo}
    <div
      class="mb-2 flex min-w-0 items-center gap-2 rounded-md border-l-2 border-blue-500 bg-blue-50 p-2 text-xs"
    >
      <span class="min-w-0 flex-1 truncate"
        >回复：{store.replyTo.text || "附件"}</span
      >
      <button
        class="tool"
        aria-label="取消回复"
        title="取消回复"
        onclick={() => {
          store.replyTo = null;
        }}><X size={14} /></button
      >
    </div>
    {#if !replyCompatible}<p class="mb-2 text-xs text-amber-700">
        当前发送方式不支持引用回复，请切换为普通、富文本或语音。
      </p>{/if}
  {/if}
  {#if advanced}
    <div class="mb-2 space-y-2 border-b border-gray-100 pb-2 text-xs">
      <div class="flex flex-wrap items-center gap-2">
        <label
          >发送方式 <select
            aria-label="发送方式"
            bind:value={mode}
            class="rounded border border-gray-200 p-1"
            onchange={() => {
              file = null;
              allowSms = false;
              service = "auto";
              styles = [];
              subject = "";
              effect = "";
              store.replyTo = null;
              if (fileInput) fileInput.value = "";
            }}
          >
            <option value="standard">普通消息</option>
            <option
              value="tracked"
              disabled={!store.supports("send.tracked") || isSms}
              >可追踪文字消息</option
            >
            <option value="rich" disabled={!store.supports("send.rich")}
              >富文本 / 特效</option
            >
            <option value="url" disabled={!store.supports("send.rich") || isSms}
              >链接卡片</option
            >
            <option
              value="audio"
              disabled={!store.supports("send.attachment") || isSms}
              >原生语音附件</option
            >
            <option
              value="sticker"
              disabled={!store.supports("send.sticker") || isSms}>贴纸</option
            >
            <option
              value="multipart"
              disabled={!store.supports("send.multipart") || isSms}
              >分段消息</option
            >
            <option
              value="poll"
              disabled={!store.supports("poll.send") || isSms}>原生投票</option
            >
          </select></label
        >
        {#if mode === "standard"}
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
          <label class="flex items-center gap-1"
            ><input
              type="checkbox"
              bind:checked={allowSms}
            />允许短信回退</label
          >
        {/if}
        <label
          class="flex items-center gap-1"
          title={store.capabilityReason("typing") || "向对方显示正在输入"}
          ><input
            type="checkbox"
            disabled={!store.supports("typing")}
            checked={typingEnabled}
            onchange={(event) => {
              if (!event.currentTarget.checked) stopTyping();
              typingEnabled = event.currentTarget.checked;
            }}
          />发送输入状态</label
        >
      </div>
      {#if mode === "rich"}
        <div class="flex flex-wrap items-center gap-1">
          {#each [{ name: "bold", label: "粗体", icon: Bold }, { name: "italic", label: "斜体", icon: Italic }, { name: "underline", label: "下划线", icon: Underline }, { name: "strikethrough", label: "删除线", icon: Strikethrough }] as style (style.name)}
            <button
              type="button"
              aria-label={style.label}
              title={`${style.label}（整条消息）`}
              aria-pressed={styles.includes(style.name)}
              class={`tool ${styles.includes(style.name) ? "bg-blue-100 text-blue-700" : ""}`}
              onclick={() => toggleStyle(style.name)}
              ><style.icon size={15} /></button
            >
          {/each}
          <input
            aria-label="消息主题"
            placeholder="主题"
            bind:value={subject}
            class="min-w-0 flex-1 rounded border border-gray-200 p-1"
          />
          <select
            aria-label="消息特效"
            bind:value={effect}
            class="rounded border border-gray-200 p-1"
            ><option value="">无特效</option
            >{#each ["impact", "loud", "gentle", "invisibleink", "confetti", "lasers", "fireworks", "balloons", "sparkles", "spotlight", "echo", "love", "celebration"] as name (name)}<option
                value={name}>{name}</option
              >{/each}</select
          >
        </div>
      {/if}
      {#if mode === "poll"}<textarea
          aria-label="投票选项"
          placeholder="每行一个选项，至少两个"
          rows="3"
          bind:value={options}
          class="w-full rounded-md border border-gray-200 p-2"
        ></textarea>{/if}
      {#if mode === "multipart"}<p class="text-gray-500">
          空行分隔各段，最多 20 段。
        </p>{/if}
      {#if !store.status?.bridge.ready}<p class="text-gray-500">
          高级发送暂不可用：IMCore bridge 未就绪。
        </p>{/if}
    </div>
  {/if}
  {#if file}
    <div class="mb-2 flex items-center gap-2 text-xs text-gray-500">
      <Paperclip size={14} /><span class="min-w-0 flex-1 truncate"
        >{file.name}</span
      ><button
        type="button"
        class="tool"
        aria-label="移除附件"
        title="移除附件"
        onclick={() => {
          file = null;
          if (fileInput) fileInput.value = "";
        }}><X size={14} /></button
      >
    </div>
  {/if}
  <form
    class="flex items-end gap-1"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <button
      type="button"
      class="tool"
      aria-label="发送选项"
      title="发送选项"
      aria-expanded={advanced}
      onclick={() => {
        advanced = !advanced;
      }}><SlidersHorizontal size={18} /></button
    >
    <label
      class={`tool ${["url", "multipart", "poll", "tracked"].includes(mode) ? "hidden" : "cursor-pointer"}`}
      title="Attach a file"
      aria-label="Attach a file"
    >
      <Paperclip size={18} /><input
        bind:this={fileInput}
        type="file"
        class="hidden"
        accept={mode === "audio"
          ? "audio/*"
          : mode === "sticker"
            ? "image/png,image/jpeg,image/gif"
            : undefined}
        disabled={sending}
        onchange={(event) => {
          file = event.currentTarget.files?.[0] ?? null;
        }}
      />
    </label>
    <textarea
      bind:value={text}
      oninput={onInput}
      onkeydown={(event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.isComposing &&
          mode !== "multipart"
        ) {
          event.preventDefault();
          void submit();
        }
      }}
      rows="1"
      aria-label="消息正文"
      placeholder={mode === "poll"
        ? "投票问题"
        : mode === "url"
          ? "https://…"
          : mode === "audio" || mode === "sticker"
            ? "请选择附件"
            : isSms
              ? "Text Message"
              : "iMessage"}
      disabled={sending || mode === "audio" || mode === "sticker"}
      class="max-h-32 min-w-0 flex-1 resize-y rounded-lg border border-gray-300 px-3 py-2 text-[15px] focus:border-blue-500 focus:outline-none"
    ></textarea>
    <button
      type="submit"
      aria-label="Send"
      title={store.capabilityReason(selectedMethod) || "发送"}
      disabled={!canSend}
      class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40 ${isSms ? "bg-green-600" : "bg-blue-600"}`}
      ><ArrowUp size={18} /></button
    >
  </form>
</footer>
