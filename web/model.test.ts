import { expect, test } from "bun:test";
import {
  applyReactionEvent,
  bumpChat,
  filterChats,
  updateEditedMessage,
  upsertMessage,
} from "./model";
import type { ApiChat, ApiMessage } from "../server/payloads";

test("successful edits update cached messages outside the newest history page", () => {
  const list = [makeMessage(10), makeMessage(200)];
  const next = updateEditedMessage(list, "G-10", "updated old message");
  expect(next[0]?.text).toBe("updated old message");
  expect(next[1]).toBe(list[1]);
  expect(list[0]?.text).toBe("message 10");
});

function makeMessage(
  id: number,
  overrides: Partial<ApiMessage> = {},
): ApiMessage {
  return {
    id,
    chat_id: 1,
    guid: `G-${id}`,
    sender: "+15551234567",
    is_from_me: false,
    text: `message ${id}`,
    created_at: `2026-06-10T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
    attachments: [],
    reactions: [],
    chat_identifier: "+15551234567",
    chat_guid: "iMessage;-;+15551234567",
    chat_name: "Ada",
    participants: ["+15551234567"],
    is_group: false,
    ...overrides,
  };
}

function makeChat(id: number, lastMessageAt: string): ApiChat {
  return {
    id,
    identifier: `chat-${id}`,
    guid: `iMessage;-;chat-${id}`,
    name: `Chat ${id}`,
    service: "iMessage",
    last_message_at: lastMessageAt,
    participants: [],
    is_group: false,
    display_name: `Chat ${id}`,
    last_message: null,
  };
}

test("upsertMessage appends, inserts sorted, and replaces by id", () => {
  let list: ApiMessage[] = [];
  list = upsertMessage(list, makeMessage(10));
  list = upsertMessage(list, makeMessage(12));
  list = upsertMessage(list, makeMessage(11));
  expect(list.map((m) => m.id)).toEqual([10, 11, 12]);

  list = upsertMessage(list, makeMessage(11, { text: "edited" }));
  expect(list.map((m) => m.id)).toEqual([10, 11, 12]);
  expect(list[1]?.text).toBe("edited");
});

test("applyReactionEvent adds and removes aggregated reactions", () => {
  const list = [makeMessage(10)];
  const add = makeMessage(20, {
    is_reaction: true,
    reaction_type: "love",
    reaction_emoji: "❤️",
    is_reaction_add: true,
    reacted_to_guid: "G-10",
  });
  const added = applyReactionEvent(list, add);
  expect(added[0]?.reactions).toHaveLength(1);
  expect(added[0]?.reactions[0]?.emoji).toBe("❤️");
  // the event row itself is never inserted
  expect(added).toHaveLength(1);

  // imsg reports the peer's handle as sender even for own reactions, so
  // identity must include is_from_me: removing MY love must not drop theirs
  const ownRemove = makeMessage(21, {
    is_reaction: true,
    reaction_type: "love",
    is_reaction_add: false,
    is_from_me: true,
    reacted_to_guid: "G-10",
  });
  expect(applyReactionEvent(added, ownRemove)[0]?.reactions).toHaveLength(1);

  const remove = makeMessage(22, {
    is_reaction: true,
    reaction_type: "love",
    is_reaction_add: false,
    reacted_to_guid: "G-10",
  });
  expect(applyReactionEvent(added, remove)[0]?.reactions).toHaveLength(0);
});

test("applyReactionEvent ignores unknown targets", () => {
  const list = [makeMessage(10)];
  const event = makeMessage(20, {
    is_reaction: true,
    reaction_type: "like",
    is_reaction_add: true,
    reacted_to_guid: "G-MISSING",
  });
  expect(applyReactionEvent(list, event)).toBe(list);
});

test("bumpChat updates the preview and reorders by recency", () => {
  const chats = [
    makeChat(1, "2026-06-10T00:00:05.000Z"),
    makeChat(2, "2026-06-10T00:00:01.000Z"),
  ];
  const bumped = bumpChat(
    chats,
    makeMessage(50, { chat_id: 2, created_at: "2026-06-10T00:00:09.000Z" }),
  );
  expect(bumped?.map((c) => c.id)).toEqual([2, 1]);
  expect(bumped?.[0]?.last_message?.text).toBe("message 50");
});

test("bumpChat ignores stale replays and signals unknown chats", () => {
  const chats = [makeChat(1, "2026-06-10T00:00:05.000Z")];
  const stale = bumpChat(
    chats,
    makeMessage(50, { chat_id: 1, created_at: "2026-06-10T00:00:01.000Z" }),
  );
  expect(stale?.[0]?.last_message).toBeNull();

  expect(bumpChat(chats, makeMessage(51, { chat_id: 7 }))).toBeNull();
});

test("conversation filters find participants and honor unread without hiding groups", () => {
  const chats = [
    {
      ...makeChat(1, "2026-06-10T00:00:05.000Z"),
      unread_count: 3,
      participants: ["someone@example.com"],
    },
    {
      ...makeChat(2, "2026-06-10T00:00:05.000Z"),
      unread_count: 0,
      is_group: true,
      display_name: "Project",
    },
  ];
  expect(filterChats(chats, "EXAMPLE", false).map((c) => c.id)).toEqual([1]);
  expect(filterChats(chats, "", true).map((c) => c.id)).toEqual([1]);
  expect(filterChats(chats, "project", false).map((c) => c.id)).toEqual([2]);
});
