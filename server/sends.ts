import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { invalidParams, requireMethods } from "./actions";
import { rpc, type EffectId, type TextFormattingRun } from "./rpc";

const booleanForm = z.enum(["true", "false"]).transform((v) => v === "true");
const formatting = z
  .array(
    z
      .object({
        start: z.number().int().nonnegative(),
        length: z.number().int().positive(),
        styles: z
          .array(z.enum(["bold", "italic", "underline", "strikethrough"]))
          .min(1),
      })
      .strict(),
  )
  .max(1000);
const parts = z
  .array(
    z
      .object({
        text: z.string().min(1),
        text_formatting: formatting.optional(),
      })
      .strict(),
  )
  .min(1)
  .max(20);
const jsonField = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
const formSchema = z
  .object({
    to: z.string().trim().min(1).optional(),
    chat_id: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    text: z.string().max(100000).optional(),
    file: z.instanceof(File).optional(),
    mode: z
      .enum([
        "standard",
        "rich",
        "audio",
        "sticker",
        "url",
        "multipart",
        "tracked",
      ])
      .default("standard"),
    service: z.enum(["auto", "imessage", "sms"]).default("auto"),
    allow_sms_fallback: booleanForm.default(false),
    attempt_id: z.uuid().optional(),
    reply_to: z.string().trim().min(1).optional(),
    text_formatting: jsonField(formatting).optional(),
    subject: z.string().max(16384).optional(),
    effect_id: z.string().min(1).max(256).optional(),
    url: z
      .url()
      .refine((value) => /^https?:\/\//i.test(value), "HTTP(S) URL required")
      .optional(),
    parts: jsonField(parts).optional(),
  })
  .strict()
  .refine(
    (p) => (p.to !== undefined) !== (p.chat_id !== undefined),
    "provide exactly one of to or chat_id",
  );

export function parseUploadForm(
  form: FormData,
): Record<string, FormDataEntryValue> {
  const entries: Record<string, FormDataEntryValue> = {};
  for (const [key, value] of form) {
    if (Object.hasOwn(entries, key))
      invalidParams(
        `multiple ${key} values are not supported; send files separately`,
      );
    if (
      value instanceof File &&
      (value.size === 0 || value.size > 100 * 1024 * 1024)
    )
      invalidParams("file must be nonempty and at most 100 MiB");
    entries[key] = value;
  }
  return entries;
}

export async function withStagedUpload<T>(
  file: File | undefined,
  run: (path: string | undefined) => Promise<T>,
): Promise<T> {
  if (!file) return run(undefined);
  const directory = await mkdtemp(join(tmpdir(), "imsgweb-"));
  const path = join(
    directory,
    basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload",
  );
  try {
    await Bun.write(path, file);
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateFormatting(text: string, runs?: TextFormattingRun[]) {
  if (runs?.some((run) => run.start + run.length > text.length))
    invalidParams("formatting run exceeds UTF-16 text length");
}

export async function sendMessage(form: FormData) {
  const parsed = formSchema.safeParse(parseUploadForm(form));
  if (!parsed.success) invalidParams(parsed.error.message);
  const p = parsed.data;
  const hasText = Boolean(p.text?.trim());
  const isRich = p.mode === "rich";
  const isTracked = p.mode === "tracked";
  if (isTracked) {
    if (!p.attempt_id || !hasText)
      invalidParams("tracked mode requires attempt_id UUID and nonempty text");
    if (
      [
        p.file,
        p.text_formatting,
        p.reply_to,
        p.subject,
        p.effect_id,
        p.url,
        p.parts,
      ].some((value) => value !== undefined)
    )
      invalidParams("tracked mode is text-only and rejects send modifiers");
  } else if (p.attempt_id !== undefined)
    invalidParams("attempt_id is only valid in tracked mode");
  if (p.mode !== "standard" && !isTracked && p.chat_id === undefined)
    invalidParams("advanced send modes require chat_id");
  if (p.mode !== "standard" && !isTracked && p.service === "sms")
    invalidParams("advanced sends are iMessage-only");
  if (p.mode !== "standard" && p.allow_sms_fallback)
    invalidParams("SMS fallback is only valid for standard mode");
  if (
    !isRich &&
    p.mode !== "multipart" &&
    (p.subject !== undefined || p.effect_id !== undefined)
  )
    invalidParams("subject/effect_id require rich mode or multipart mode");
  if (p.url !== undefined && p.mode !== "url")
    invalidParams("url requires URL mode");
  if (p.parts !== undefined && p.mode !== "multipart")
    invalidParams("parts require multipart mode");
  if (
    ["audio", "sticker", "url", "multipart"].includes(p.mode) &&
    (p.text !== undefined ||
      p.text_formatting !== undefined ||
      (p.reply_to !== undefined && p.mode !== "audio"))
  )
    invalidParams("modifiers are not supported in this send mode");
  if (["standard", "rich"].includes(p.mode) && !hasText && !p.file)
    invalidParams("provide text and/or file");
  if (["audio", "sticker"].includes(p.mode) && !p.file)
    invalidParams("file required");
  if (["url", "multipart"].includes(p.mode) && p.file)
    invalidParams("files are not supported in this mode");
  if (p.mode === "url" && !p.url) invalidParams("url required");
  if (p.mode === "multipart" && !p.parts) invalidParams("parts required");
  if (p.mode === "audio" && p.file && !/^audio\//.test(p.file.type))
    invalidParams("audio upload required");
  if (
    p.mode === "sticker" &&
    p.file &&
    (!/^image\/(png|apng|jpeg|gif)$/.test(p.file.type) ||
      p.file.size > 500 * 1024)
  )
    invalidParams("stickers require PNG, GIF or JPEG at most 500 KiB");
  validateFormatting(p.text ?? "", p.text_formatting);
  p.parts?.forEach((item) =>
    validateFormatting(item.text, item.text_formatting),
  );
  const method = {
    standard: "send",
    rich: "send.rich",
    audio: "send.attachment",
    sticker: "send.sticker",
    url: "send.rich",
    multipart: "send.multipart",
    tracked: "send.tracked",
  }[p.mode];
  const needed = [method];
  if (isRich && p.file) needed.push("send.attachment");
  if (p.mode === "standard" && (p.reply_to || p.text_formatting?.length))
    needed.push("send.rich");
  const status = await requireMethods(needed);
  if (
    p.mode === "url" &&
    (status.bridge.selectors?.["urlPreviewMessage"] !== true ||
      status.bridge.selectors?.["sendRichLinkAction"] !== true)
  )
    invalidParams("running bridge does not support rich links");
  if (
    (isTracked || p.chat_id !== undefined || (isRich && p.file)) &&
    !status.database.ready
  )
    invalidParams("database must be ready for this send");
  if (p.mode !== "standard" && !isTracked) {
    await requireMethods(["chats.get"], status);
    const info = await rpc.call("chats.get", { chat_id: p.chat_id! });
    if (info.service.toLowerCase() !== "imessage")
      invalidParams("advanced sends require an existing iMessage chat");
  }
  return withStagedUpload(p.file, async (file) => {
    const target = { chat_id: p.chat_id };
    switch (p.mode) {
      case "tracked":
        return rpc.call("send.tracked", {
          ...(p.to ? { to: p.to } : target),
          text: p.text!,
          attempt_id: p.attempt_id!,
          service: p.service,
          transport: "bridge",
          allow_sms_fallback: false,
        });
      case "standard":
        return rpc.call("send", {
          ...(p.to ? { to: p.to } : target),
          text: p.text,
          file,
          service: p.service,
          allow_sms_fallback: p.allow_sms_fallback,
          reply_to: p.reply_to,
          text_formatting: p.text_formatting,
          ...(p.reply_to || p.text_formatting?.length
            ? { transport: "bridge" as const }
            : {}),
        });
      case "rich":
        return rpc.call("send.rich", {
          ...target,
          text: p.text,
          file,
          reply_to: p.reply_to,
          text_formatting: p.text_formatting,
          subject: p.subject,
          effect_id: p.effect_id as EffectId | undefined,
        });
      case "audio":
        return rpc.call("send.attachment", {
          ...target,
          file: file!,
          audio: true,
          reply_to: p.reply_to,
        });
      case "sticker":
        return rpc.call("send.sticker", { ...target, file: file! });
      case "url":
        return rpc.call("send.rich", { ...target, url: p.url });
      case "multipart":
        return rpc.call("send.multipart", {
          ...target,
          parts: p.parts!,
          subject: p.subject,
          effect_id: p.effect_id as EffectId | undefined,
        });
    }
  });
}
