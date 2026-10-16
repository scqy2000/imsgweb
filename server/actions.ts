import { z } from "zod";
import {
  rpc,
  RpcError,
  RpcErrorCode,
  type ImsgMethod,
  type ImsgRpcMethods,
  type StatusResult,
} from "./rpc";

const nonempty = z.string().trim().min(1).max(16384);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const part = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const chat = {
  chat_id: positive.optional(),
  chat_identifier: nonempty.optional(),
  chat_guid: nonempty.optional(),
};
const message = {
  message_id: nonempty.optional(),
  message_guid: nonempty.optional(),
};
const exactlyOne = (value: Record<string, unknown>, keys: string[]) =>
  keys.filter((key) => value[key] !== undefined).length === 1;
const target = <T extends z.ZodRawShape>(extra: T, direct = false) =>
  z
    .object({
      ...chat,
      ...(direct ? { to: nonempty.optional() } : {}),
      ...extra,
    })
    .strict()
    .refine(
      (p) => exactlyOne(p, [...Object.keys(chat), ...(direct ? ["to"] : [])]),
      "provide exactly one chat target",
    );
const messageAction = <T extends z.ZodRawShape>(extra: T) =>
  target({ ...message, ...extra }).refine(
    (p) => exactlyOne(p, Object.keys(message)),
    "provide exactly one message target",
  );
const vote = target({
  poll_guid: nonempty,
  option_id: nonempty.optional(),
  option_index: positive.optional(),
  option: nonempty.optional(),
}).refine(
  (p) => exactlyOne(p, ["option_id", "option_index", "option"]),
  "provide exactly one option selector",
);
const reactions = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
] as const;
const reaction = z
  .string()
  .refine(
    (s) => reactions.some((r) => s === r || s === `remove-${r}`),
    "invalid reaction",
  );

// Canonical spellings only. No file/path fields or unlisted methods reach RPC.
export const actionSchemas = {
  read: target({}, true),
  typing: target(
    {
      typing: z.boolean().optional(),
      service: z.enum(["imessage", "sms"]).optional(),
    },
    true,
  ),
  "chats.create": z
    .object({
      addresses: z.array(nonempty).min(1).max(100),
      service: z
        .string()
        .regex(/^imessage$/i)
        .optional(),
      name: z.string().max(16384).optional(),
      text: z.string().max(100000).optional(),
    })
    .strict(),
  "chats.delete": target({}),
  "chats.markUnread": target({}),
  "group.rename": target({ name: z.string().max(16384) }),
  "group.setIcon": target({}),
  "group.addParticipant": target({ address: nonempty }),
  "group.removeParticipant": target({ address: nonempty }),
  "group.leave": target({}),
  tapback: messageAction({
    reaction,
    remove: z.boolean().optional(),
    part_index: part.optional(),
  }),
  "message.edit": messageAction({
    text: nonempty,
    backwards_compatibility_message: z.string().max(100000).optional(),
    part_index: part.optional(),
  }),
  "message.unsend": messageAction({ part_index: part.optional() }),
  "message.delete": messageAction({}),
  "message.notifyAnyways": messageAction({}),
  "poll.send": target({
    question: nonempty,
    options: z.array(nonempty).min(2).max(100),
    creator_handle: nonempty.optional(),
    reply_to: nonempty.optional(),
    comment: nonempty.optional(),
    suppress_comment: z.boolean().optional(),
  }).refine(
    (p) => !(p.comment !== undefined && p.suppress_comment === true),
    "comment conflicts with suppress_comment",
  ),
  "poll.vote": vote,
  "poll.unvote": vote,
  "contacts.shouldShareContact": target({}),
  "contacts.shareContactCard": target({}),
  "handles.check": z
    .object({
      address: nonempty,
      alias_type: z.enum(["phone", "email"]).optional(),
      service: z.literal("iMessage").optional(),
    })
    .strict(),
} satisfies Partial<Record<ImsgMethod, z.ZodType>>;

export type ActionMethod = keyof typeof actionSchemas;
const confirmationRequired = new Set<ActionMethod>([
  "read",
  "chats.delete",
  "group.setIcon",
  "group.addParticipant",
  "group.removeParticipant",
  "group.leave",
  "message.edit",
  "message.unsend",
  "message.delete",
  "message.notifyAnyways",
  "contacts.shareContactCard",
]);

export const actionEnvelope = z
  .object({
    method: z.string(),
    params: z.record(z.string(), z.unknown()),
    confirmed: z.boolean().optional(),
  })
  .strict();

export function invalidParams(detail: string): never {
  throw new RpcError({
    code: RpcErrorCode.InvalidParams,
    message: "Invalid params",
    data: detail,
  });
}

export async function requireMethods(
  methods: string[],
  status?: StatusResult,
): Promise<StatusResult> {
  const snapshot = status ?? (await rpc.call("status"));
  const missing = methods.find((method) => !snapshot.methods.includes(method));
  if (missing)
    throw new RpcError({
      code: RpcErrorCode.BridgeUnavailable,
      message: "Capability unavailable",
      data: `${missing} is not currently available`,
    });
  return snapshot;
}

export function parseAction(
  method: string,
  params: unknown,
): { method: ActionMethod; params: ImsgRpcMethods[ActionMethod]["params"] } {
  if (!Object.hasOwn(actionSchemas, method))
    invalidParams("method is not allowlisted");
  const key = method as ActionMethod;
  const parsed = actionSchemas[key].safeParse(params);
  if (!parsed.success) invalidParams(parsed.error.message);
  return {
    method: key,
    params: parsed.data as ImsgRpcMethods[ActionMethod]["params"],
  };
}

export async function performAction(input: z.infer<typeof actionEnvelope>) {
  const action = parseAction(input.method, input.params);
  if (confirmationRequired.has(action.method) && input.confirmed !== true)
    invalidParams("explicit confirmation required");
  await requireMethods([action.method]);
  return rpc.call(action.method, action.params);
}
