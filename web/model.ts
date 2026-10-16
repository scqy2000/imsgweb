/**
 * Pure data logic for the UI state — no Svelte imports so it's directly
 * testable with `bun test`. The invariants here come from the imsg wire
 * contract (see server/rpc/types.ts): message ids are monotonic rowids that
 * can be re-emitted (upsert, never append blindly), and reaction events are
 * standalone rows that reference their target by reacted_to_guid.
 */
import { previewText } from "../server/preview";
import type { ApiChat, ApiMessage } from "../server/payloads";

export function updateEditedMessage(
  list: ApiMessage[],
  guid: string,
  text: string,
): ApiMessage[] {
  return list.map((message) =>
    message.guid.toLowerCase() === guid.toLowerCase()
      ? { ...message, text }
      : message,
  );
}

export function filterChats(
  chats: ApiChat[],
  query: string,
  unreadOnly: boolean,
): ApiChat[] {
  const needle = query.trim().toLocaleLowerCase();
  return chats.filter(
    (chat) =>
      (!unreadOnly || (chat.unread_count ?? 0) > 0) &&
      (!needle ||
        [chat.display_name, chat.identifier, ...chat.participants].some(
          (value) => value.toLocaleLowerCase().includes(needle),
        )),
  );
}

/** Insert or replace by id, keeping the list sorted by id (oldest first). */
export function upsertMessage(
  list: ApiMessage[],
  message: ApiMessage,
): ApiMessage[] {
  const index = list.findIndex((m) => m.id === message.id);
  if (index !== -1) {
    const next = [...list];
    next[index] = message;
    return next;
  }
  const last = list[list.length - 1];
  if (last === undefined || last.id < message.id) return [...list, message];
  const next = [...list, message];
  next.sort((a, b) => a.id - b.id);
  return next;
}

/** Apply a tapback add/remove event to its target message's aggregated
 *  reactions. The event row itself is never inserted into the list. */
export function applyReactionEvent(
  list: ApiMessage[],
  event: ApiMessage,
): ApiMessage[] {
  const targetGuid = event.reacted_to_guid;
  if (targetGuid === undefined) return list;
  const index = list.findIndex((m) => m.guid === targetGuid);
  const target = index === -1 ? undefined : list[index];
  if (!target) return list;

  // sender alone is ambiguous: imsg reports the PEER's handle even on
  // is_from_me rows, so own and peer reactions can share a sender
  const withoutSenders = target.reactions.filter(
    (r) =>
      !(
        r.sender === event.sender &&
        r.is_from_me === event.is_from_me &&
        r.type === event.reaction_type
      ),
  );
  const reactions = event.is_reaction_add
    ? [
        ...withoutSenders,
        {
          id: event.id,
          type: event.reaction_type ?? "custom",
          emoji: event.reaction_emoji ?? "",
          sender: event.sender,
          sender_name: event.sender_name,
          is_from_me: event.is_from_me,
          created_at: event.created_at,
        },
      ]
    : withoutSenders;

  const next = [...list];
  next[index] = { ...target, reactions };
  return next;
}

/**
 * Update a chat's preview from an incoming message and re-sort by recency.
 * Returns null when the chat is unknown (caller should refetch the chat
 * list — e.g. a send to a new handle just created a chat). Messages older
 * than the current preview (SSE replay after resume) leave the list as-is.
 */
export function bumpChat(
  chats: ApiChat[],
  message: ApiMessage,
): ApiChat[] | null {
  const index = chats.findIndex((c) => c.id === message.chat_id);
  const chat = index === -1 ? undefined : chats[index];
  if (!chat) return null;
  if (message.created_at < chat.last_message_at) return chats;

  const next = [...chats];
  next[index] = {
    ...chat,
    last_message_at: message.created_at,
    last_message: {
      text: previewText(message),
      sender_name: message.sender_name,
      is_from_me: message.is_from_me,
      created_at: message.created_at,
    },
  };
  next.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
  return next;
}
