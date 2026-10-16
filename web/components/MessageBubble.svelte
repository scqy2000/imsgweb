<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import CheckCheck from "@lucide/svelte/icons/check-check";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Clock from "@lucide/svelte/icons/clock";
  import FileDown from "@lucide/svelte/icons/file-down";
  import ImageOff from "@lucide/svelte/icons/image-off";
  import Vote from "@lucide/svelte/icons/vote";
  import type { ApiMessage } from "../../server/payloads";
  import { cleanText } from "../../server/preview";
  import { bubbleTime } from "../format";
  import { store } from "../store.svelte";
  import MessageActions from "./MessageActions.svelte";

  const {
    message,
    isGroup,
    isSms,
    isLatestOwn = false,
  }: {
    message: ApiMessage;
    isGroup: boolean;
    isSms: boolean;
    isLatestOwn?: boolean;
  } = $props();

  const text = $derived(cleanText(message.text));
  const status = $derived(
    isLatestOwn ? store.sendStates[message.guid] : undefined,
  );
  const highlighted = $derived(store.highlightedGuid === message.guid);

  function voteCount(optionId: string): number {
    return (message.poll?.votes ?? []).filter((v) => v.option_id === optionId)
      .length;
  }
  // the quoted text was resolved preferring the thread originator
  const quotedGuid = $derived(
    message.thread_originator_guid ?? message.reply_to_guid,
  );
</script>

<div
  class={`group mb-2 flex ${message.is_from_me ? "justify-end" : "justify-start"}`}
  data-guid={message.guid}
>
  <div class="min-w-0 max-w-[85%] sm:max-w-[70%]">
    <div class="flex items-center justify-between gap-2 text-xs text-gray-400">
      <span>{bubbleTime(message.created_at)}</span><MessageActions {message} />
    </div>
    {#if isGroup && !message.is_from_me}
      <div class="mb-0.5 ml-2 text-xs text-gray-500">
        {message.sender_name ?? message.sender}
      </div>
    {/if}
    <div
      class={`rounded-2xl px-3 py-1.5 transition-shadow duration-500 ${
        message.is_from_me
          ? `${isSms ? "bg-green-500" : "bg-blue-500"} text-white`
          : "bg-gray-200 text-gray-900"
      } ${highlighted ? "ring-2 ring-amber-400" : ""}`}
      title={bubbleTime(message.created_at)}
    >
      {#if message.reply_to_text && quotedGuid}
        <button
          type="button"
          title="Jump to the quoted message"
          onclick={() => store.jumpToMessage(message.chat_id, quotedGuid)}
          class={`mb-1 block w-full cursor-pointer border-l-2 pl-2 text-left text-xs ${
            message.is_from_me
              ? "border-white/50 text-white/80"
              : "border-gray-400 text-gray-500"
          }`}
        >
          {message.reply_to_text}
        </button>
      {/if}
      {#if message.poll}
        <div class="my-1 rounded-lg bg-black/10 px-2.5 py-1.5 text-sm">
          <div class="flex items-center gap-1.5 font-medium">
            <Vote size={14} class="shrink-0" />
            {message.poll.question || "Poll"}
          </div>
          {#if message.poll.options?.length}
            <ul class="mt-1 space-y-0.5">
              {#each message.poll.options as option (option.id)}
                <li class="flex items-center justify-between gap-3 text-xs">
                  <span>{option.text}</span>
                  <span class="tabular-nums opacity-70">
                    {voteCount(option.id)}
                  </span>
                  <button
                    class="rounded border border-current/20 px-2 py-1 disabled:opacity-40"
                    disabled={!store.supports("poll.vote") ||
                      store.mutationBusy ||
                      !!store.uncertainty}
                    title={store.capabilityReason("poll.vote") || "投票"}
                    onclick={() =>
                      void store.runAction("poll.vote", {
                        chat_id: message.chat_id,
                        poll_guid: message.poll?.poll_guid ?? message.guid,
                        option_id: option.id,
                      })}>投票</button
                  >
                  <button
                    class="rounded border border-current/20 px-2 py-1 disabled:opacity-40"
                    disabled={!store.supports("poll.unvote") ||
                      store.mutationBusy ||
                      !!store.uncertainty}
                    title={store.capabilityReason("poll.unvote") || "取消投票"}
                    onclick={() =>
                      void store.runAction("poll.unvote", {
                        chat_id: message.chat_id,
                        poll_guid: message.poll?.poll_guid ?? message.guid,
                        option_id: option.id,
                      })}>取消</button
                  >
                </li>
              {/each}
            </ul>
          {:else if message.poll.kind === "vote" && message.poll.vote}
            <p class="mt-0.5 text-xs opacity-80">
              voted: {message.poll.vote.option_text ??
                message.poll.vote.option_id}
            </p>
          {/if}
        </div>
      {/if}
      {#each message.attachments as attachment, attachmentIndex (attachmentIndex)}
        {#if attachment.missing || !attachment.url}
          <div
            class="my-1 flex items-center gap-1.5 rounded bg-black/10 px-2 py-1 text-xs italic"
            title={attachment.missing
              ? "Not downloaded from iCloud yet"
              : "Unavailable"}
          >
            <ImageOff size={14} />
            {attachment.transfer_name || "attachment"}
          </div>
        {:else if attachment.mime_type.startsWith("image/")}
          <img
            src={attachment.url}
            alt={attachment.transfer_name}
            loading="lazy"
            class="my-1 max-h-64 rounded-lg"
          />
        {:else if attachment.mime_type.startsWith("audio/")}
          <audio controls src={attachment.url} class="my-1 max-w-full"></audio>
        {:else if attachment.mime_type.startsWith("video/")}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video controls src={attachment.url} class="my-1 max-h-64 rounded-lg"
          ></video>
        {:else}
          <a
            href={attachment.url}
            download={attachment.transfer_name}
            class="my-1 flex items-center gap-1.5 text-sm underline"
          >
            <FileDown size={16} class="shrink-0" />
            {attachment.transfer_name || "attachment"}
          </a>
        {/if}
      {/each}
      {#if text}
        <p class="text-[15px] break-words whitespace-pre-wrap">{text}</p>
      {/if}
    </div>
    {#if message.reactions.length > 0}
      <div
        class={`mt-0.5 flex gap-0.5 text-sm ${message.is_from_me ? "justify-end" : ""}`}
      >
        {#each message.reactions as reaction (reaction.id)}
          <span title={reaction.sender_name ?? reaction.sender}>
            {reaction.emoji}
          </span>
        {/each}
      </div>
    {/if}
    {#if status}
      <div class="mt-0.5 flex justify-end text-gray-400">
        {#if status === "read"}
          <span class="text-blue-500" title="Read"
            ><CheckCheck size={14} /></span
          >
        {:else if status === "delivered"}
          <span title="Delivered"><CheckCheck size={14} /></span>
        {:else if status === "sent"}
          <span title="Sent"><Check size={14} /></span>
        {:else if status === "failed"}
          <span class="text-red-500" title="Failed">
            <CircleAlert size={14} />
          </span>
        {:else}
          <span title="Sending…"><Clock size={14} /></span>
        {/if}
        <span class="sr-only">{status}</span>
      </div>
    {/if}
  </div>
</div>
