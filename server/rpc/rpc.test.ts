import { expect, test } from "bun:test";
import { join } from "node:path";
import { RpcClient, RpcError, WatchOverflowError } from "./index";

// The centralized imsg stand-in; see mock.ts for fixtures and triggers.
const MOCK_CMD = ["bun", join(import.meta.dir, "mock.ts")];

test("call resolves with the typed result", async () => {
  const client = new RpcClient(MOCK_CMD);
  const { chats } = await client.call("chats.list");
  expect(chats.length).toBeGreaterThanOrEqual(3);
  expect(chats.map((chat) => chat.name)).toContain("Ada");
  await client.stop();
});

test("error responses reject with RpcError", async () => {
  const client = new RpcClient(MOCK_CMD);
  const error = await client
    .call("messages.history", { chat_id: 12345 })
    .then(() => null)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RpcError);
  if (error instanceof RpcError) {
    expect(error.code).toBe(-32602);
    expect(error.message).toBe("unknown chat_id");
    expect(error.label).toBe("Invalid params");
  }
  await client.stop();
});

test("watch replays from since_rowid and unsubscribes on break", async () => {
  const client = new RpcClient(MOCK_CMD);
  const watch = await client.watch({ chat_id: 1, since_rowid: -1 });
  expect(watch.subscription).toBe(1);
  const texts: string[] = [];
  for await (const message of watch) {
    texts.push(message.text);
    if (texts.length === 2) break;
  }
  expect(texts).toEqual(["first", "second"]);
  await client.stop();
});

test("watch throws when the subscription dies server-side", async () => {
  const client = new RpcClient(MOCK_CMD);
  const watch = await client.watch({ chat_id: 999, since_rowid: -1 });
  const texts: string[] = [];
  let failure: Error | null = null;
  try {
    for await (const message of watch) texts.push(message.text);
  } catch (e) {
    failure = e as Error;
  }
  expect(texts).toEqual(["doomed one", "doomed two"]);
  expect(failure?.message).toBe("stream died");
  await client.stop();
});

test("sends echo to live watches and report delivered status", async () => {
  const client = new RpcClient(MOCK_CMD);
  const watch = await client.watch({ chat_id: 1 });
  const result = await client.call("send", { chat_id: 1, text: "hi" });
  expect(result.ok).toBe(true);
  for await (const message of watch) {
    expect(message.text).toBe("hi");
    expect(message.is_from_me).toBe(true);
    expect(message.guid).toBe(result.guid ?? "");
    break;
  }
  const status = await client.call("message.send_status", {
    guid: result.guid ?? "",
  });
  expect(status.send_state).toBe("delivered");
  await client.stop();
});

test("in-flight calls reject when the process exits", async () => {
  const client = new RpcClient(MOCK_CMD);
  await expect(
    client.call("send", { to: "+15551234567", text: "__crash__" }),
  ).rejects.toThrow(/exited with code 3/);
});

test("stop ends open watches cleanly", async () => {
  const client = new RpcClient(MOCK_CMD);
  const watch = await client.watch({ chat_id: 1, since_rowid: -1 });
  const consumed = (async () => {
    const texts: string[] = [];
    for await (const message of watch) texts.push(message.text);
    return texts;
  })();
  await client.stop();
  expect(await consumed).toEqual(["first", "second"]);
});

test("object delivery errors preserve all metadata", async () => {
  const client = new RpcClient(MOCK_CMD);
  try {
    const error = await client
      .call("send", { chat_id: 1, text: "__unsafe__" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    if (!(error instanceof RpcError)) throw new Error("expected RpcError");
    expect(error.message).toBe("mock delivery cannot be proved");
    expect(error.code).toBe(-32001);
    expect(error.retry_safe).toBe(false);
    expect(error.disposition).toBe("may_have_completed");
    expect(error.data).toMatchObject({
      operation: "sendMessage",
      transport: "bridge_v2",
    });
  } finally {
    await client.stop();
  }
});

test("terminal watch overflow drains accepted messages and exposes the authoritative resume cursor", async () => {
  const client = new RpcClient([...MOCK_CMD, "--overflow"]);
  try {
    const watch = await client.watch({ chat_id: 1, since_rowid: -1 });
    const texts: string[] = [];
    let failure: unknown;
    try {
      for await (const message of watch) texts.push(message.text);
    } catch (error) {
      failure = error;
    }
    expect(texts).toEqual(["first", "second"]);
    expect(failure).toBeInstanceOf(WatchOverflowError);
    expect((failure as WatchOverflowError).resume_after_rowid).toBe(102);
  } finally {
    await client.stop();
  }
});

test("client watch buffer is bounded and stops accepting messages after local overflow", async () => {
  const client = new RpcClient(MOCK_CMD);
  try {
    const watch = await client.watch({
      chat_id: 1,
      since_rowid: -1,
      buffer_limit: 1,
    });
    await client.call("status");
    const received: number[] = [];
    let failure: unknown;
    try {
      for await (const message of watch) received.push(message.id);
    } catch (error) {
      failure = error;
    }
    expect(received).toEqual([101]);
    expect(failure).toBeInstanceOf(WatchOverflowError);
    expect((failure as WatchOverflowError).resume_after_rowid).toBe(101);
  } finally {
    await client.stop();
  }
});

test("zero watch cursor starts at the live tail instead of replaying history", async () => {
  const client = new RpcClient(MOCK_CMD);
  try {
    const watch = await client.watch({ chat_id: 1, since_rowid: 0 });
    const sent = await client.call("send", { chat_id: 1, text: "live tail" });
    for await (const message of watch) {
      expect(message.guid).toBe(sent.guid ?? "");
      break;
    }
  } finally {
    await client.stop();
  }
});

test("mock rich and audio replies expose thread routing before their live emission", async () => {
  const client = new RpcClient(MOCK_CMD);
  try {
    for (const mode of ["send.rich", "send.attachment"] as const) {
      const watch = await client.watch({ chat_id: 1 });
      if (mode === "send.rich")
        await client.call(mode, {
          chat_id: 1,
          text: "threaded reply",
          reply_to: "MOCK-101",
        });
      else
        await client.call(mode, {
          chat_id: 1,
          file: "/mock/staged.wav",
          audio: true,
          reply_to: "MOCK-101",
        });
      for await (const message of watch) {
        expect(message.thread_originator_guid).toBe("MOCK-101");
        expect(message.reply_to_guid).toBe("MOCK-101");
        expect(message.reply_to_text).toBe("first");
        expect(message.reply_to_sender).toBe("+15551234567");
        break;
      }
    }
  } finally {
    await client.stop();
  }
});
