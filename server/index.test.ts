import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

// Route the shared rpc client at the mock before its first spawn; the
// Hono app is exercised in-process via app.request (no port, no server).
process.env["IMSGWEB_RPC_CMD"] = `bun ${join(import.meta.dir, "rpc/mock.ts")}`;
const { default: app } = await import("./index");
const { rpc } = await import("./rpc");

afterAll(async () => {
  await rpc.stop();
});

interface MessagesPage {
  messages: Array<{ text: string; created_at: string }>;
  next_before: string | null;
}

test("history responds oldest-first with a cursor that pages", async () => {
  // imsg returns newest-first; the route must normalize and cursor from
  // the oldest row — regression test for one-message-per-page paging
  const res = await app.request("/api/chats/1/messages?limit=1");
  expect(res.status).toBe(200);
  const page1 = (await res.json()) as MessagesPage;
  expect(page1.messages.map((m) => m.text)).toEqual(["second"]);
  expect(page1.next_before).toBe(page1.messages[0]?.created_at ?? "");

  const res2 = await app.request(
    `/api/chats/1/messages?limit=1&before=${encodeURIComponent(page1.next_before ?? "")}`,
  );
  const page2 = (await res2.json()) as MessagesPage;
  expect(page2.messages.map((m) => m.text)).toEqual(["first"]);
});

test("attachment route matches nested store-relative paths", async () => {
  // our handler responds (404 no-store for an absent file) — Hono's bare
  // 404 would carry no cache-control, meaning :path{.+} didn't match
  const res = await app.request(
    "/api/attachments/messages/ab/cd/does-not-exist.heic",
  );
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store");

  const traversal = await app.request(
    "/api/attachments/messages/..%2F..%2F.ssh%2Fid_ed25519",
  );
  expect(traversal.status).toBe(404);

  const badStore = await app.request("/api/attachments/etc/passwd");
  expect(badStore.status).toBe(400);
});

test("password gate: 401s, login sets a cookie that passes", async () => {
  process.env["IMSGWEB_PASSWORD"] = "hunter2";
  try {
    expect((await app.request("/api/chats")).status).toBe(401);
    expect((await app.request("/api/events")).status).toBe(401);

    const login = (password: string) =>
      app.request("/api/auth", {
        method: "POST",
        body: JSON.stringify({ password }),
        headers: { "content-type": "application/json" },
      });
    expect((await login("nope")).status).toBe(401);

    const ok = await login("hunter2");
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("imsgweb_auth=");
    expect(setCookie).toContain("HttpOnly");
    // the cookie carries a hash, never the password
    expect(setCookie).not.toContain("hunter2");

    const authed = await app.request("/api/chats?limit=1", {
      headers: { cookie: setCookie.split(";")[0] ?? "" },
    });
    expect(authed.status).toBe(200);

    const badCookie = await app.request("/api/chats?limit=1", {
      headers: { cookie: "imsgweb_auth=forged" },
    });
    expect(badCookie.status).toBe(401);
  } finally {
    delete process.env["IMSGWEB_PASSWORD"];
  }
});

test("events stream flushes immediately and forwards sends", async () => {
  const controller = new AbortController();
  const res = await app.request("/api/events", { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const body = res.body;
  expect(body).not.toBeNull();
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();

  // first bytes arrive before any event so EventSource fires `open`
  let received = decoder.decode((await reader.read()).value, { stream: true });
  expect(received).toContain(": connected");

  const form = new FormData();
  form.set("chat_id", "1");
  form.set("text", "sse echo");
  const sent = await app.request("/api/messages", {
    method: "POST",
    body: form,
  });
  expect(sent.status).toBe(200);

  while (!received.includes("sse echo")) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  expect(received).toContain("event: message");
  expect(received).toContain('"text":"sse echo"');
  expect(received).toMatch(/\nid: \d+\n/);
  controller.abort();
});

const action = (method: string, params: object, confirmed?: boolean) =>
  app.request("/api/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, confirmed }),
  });

test("v0.17 status, chat identity, search, scheduled and stats contracts", async () => {
  const status = await (await app.request("/api/status")).json();
  expect(status.version).toBe("0.17.0");
  expect(status.database.features.unread_state).toBe(true);
  expect(status.methods).toContain("poll.vote");
  const info = await (await app.request("/api/chats/2/info")).json();
  expect(info.participants).toHaveLength(2);
  const search = await (
    await app.request("/api/search?query=first&chat_id=1&limit=1")
  ).json();
  expect(search.messages[0].text).toBe("first");
  expect(search.next_before).toBeNull();
  const scheduled = await (
    await app.request("/api/scheduled?chat_id=1")
  ).json();
  expect(scheduled.messages[0].scheduled_at).toBeDefined();
  expect(scheduled.messages[0].attachments).toEqual([]);
  expect(
    (await (await app.request("/api/stats?chat_id=1")).json()).total_messages,
  ).toBeGreaterThan(0);
});

test("unread filtering and rowid history pagination", async () => {
  const unread = await (
    await app.request("/api/chats?limit=5000&unread_only=true")
  ).json();
  expect(unread.chats.length).toBeGreaterThan(0);
  expect(
    unread.chats.every((c: { unread_count: number }) => c.unread_count > 0),
  ).toBe(true);
  const page = await (
    await app.request("/api/chats/1/messages?limit=1&before_rowid=102")
  ).json();
  expect(page.messages[0].id).toBe(101);
  expect(page.next_before_rowid).toBe(101);
});

test("actions reject unknown keys, paths, selectors and unconfirmed destructive work", async () => {
  for (const [method, params] of [
    ["send", { to: "+123", text: "no" }],
    ["group.setIcon", { chat_id: 2, file: "/etc/passwd" }],
    ["group.rename", { chat_id: 2, name: "x", surprise: true }],
    ["read", { chat_id: 1, chat_guid: "x" }],
    [
      "poll.vote",
      { chat_id: 2, poll_guid: "POLL", option_index: 1, option: "x" },
    ],
  ] as const)
    expect((await action(method, params, true)).status).toBe(400);
  expect((await action("chats.delete", { chat_id: 2 })).status).toBe(400);
  expect(
    (await action("contacts.shareContactCard", { chat_id: 2 })).status,
  ).toBe(400);
  expect(
    (await action("group.rename", { chat_id: 2, name: "Renamed" })).status,
  ).toBe(200);
  expect((await (await app.request("/api/chats/2/info")).json()).name).toBe(
    "Renamed",
  );
});

test("advanced send modes accept staged uploads and reject mismatched modifiers and extra files", async () => {
  for (const fields of [
    {
      mode: "rich",
      text: "formatted",
      subject: "subject",
      text_formatting: '[{"start":0,"length":9,"styles":["bold"]}]',
    },
    { mode: "url", url: "https://example.com/" },
    { mode: "multipart", parts: '[{"text":"part one"},{"text":"part two"}]' },
    {
      mode: "audio",
      file: new File(["mock audio"], "voice.wav", { type: "audio/wav" }),
    },
    {
      mode: "sticker",
      file: new File(["mock image"], "sticker.png", { type: "image/png" }),
    },
  ]) {
    const form = new FormData();
    form.set("chat_id", "1");
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const response = await app.request("/api/messages", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).guid).toBeDefined();
  }
  const form = new FormData();
  form.set("chat_id", "1");
  form.set("mode", "url");
  form.set("url", "file:///etc/passwd");
  expect(
    (await app.request("/api/messages", { method: "POST", body: form })).status,
  ).toBe(400);
  form.delete("mode");
  form.delete("url");
  form.append("file", new File(["a"], "a.txt"));
  form.append("file", new File(["b"], "b.txt"));
  expect(
    (await app.request("/api/messages", { method: "POST", body: form })).status,
  ).toBe(400);
});

test("capability denied sends and actions never dispatch even when supported_methods advertises them", async () => {
  await rpc.stop();
  const previous = process.env["IMSGWEB_RPC_CMD"];
  process.env["IMSGWEB_RPC_CMD"] =
    `${previous} --deny=send --deny=group.rename`;
  try {
    const initial = await (await app.request("/api/chats/2/info")).json();
    const response = await action("group.rename", {
      chat_id: 2,
      name: "not allowed",
    });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe(-32003);
    expect((await (await app.request("/api/chats/2/info")).json()).name).toBe(
      initial.name,
    );
    const form = new FormData();
    form.set("chat_id", "1");
    form.set("text", "denied dispatch");
    expect(
      (await app.request("/api/messages", { method: "POST", body: form }))
        .status,
    ).toBe(503);
    expect(
      (await (await app.request("/api/search?query=denied%20dispatch")).json())
        .messages,
    ).toEqual([]);
  } finally {
    await rpc.stop();
    process.env["IMSGWEB_RPC_CMD"] = previous;
  }
});

test("unsafe send outcomes retain typed error metadata without automatic retry", async () => {
  for (const [text, code, disposition] of [
    ["__unsafe__", -32001, "may_have_completed"],
    ["__inflight__", -32004, "still_in_flight"],
  ] as const) {
    const form = new FormData();
    form.set("chat_id", "1");
    form.set("text", text);
    const response = await app.request("/api/messages", {
      method: "POST",
      body: form,
    });
    const error = await response.json();
    expect(response.status).toBe(502);
    expect(error.code).toBe(code);
    expect(error.retry_safe).toBe(false);
    expect(error.disposition).toBe(disposition);
    expect(error.detail).toBe("mock delivery cannot be proved");
    expect(error.data.operation).toBe("sendMessage");
  }
});

test("icon uploads are staged and clearing requires confirmation", async () => {
  const form = new FormData();
  form.set("clear", "true");
  expect(
    (await app.request("/api/chats/2/icon", { method: "POST", body: form }))
      .status,
  ).toBe(400);
  form.set("confirmed", "true");
  expect(
    (await app.request("/api/chats/2/icon", { method: "POST", body: form }))
      .status,
  ).toBe(200);
  form.delete("clear");
  form.set("file", new File(["mock icon"], "photo.png", { type: "image/png" }));
  expect(
    (await app.request("/api/chats/2/icon", { method: "POST", body: form }))
      .status,
  ).toBe(200);
});

test("search cursors page without duplicates and invalid JSON params do not mutate", async () => {
  const first = await (
    await app.request("/api/search?query=doomed&limit=1")
  ).json();
  expect(first.messages[0].id).toBe(902);
  expect(first.next_before).toBe("902");
  const second = await (
    await app.request(
      `/api/search?query=doomed&limit=1&before=${first.next_before}`,
    )
  ).json();
  expect(second.messages[0].id).toBe(901);
  expect(second.next_before).toBeNull();
  expect((await app.request("/api/chats?unread_only=1")).status).toBe(400);
  const before = await (await app.request("/api/chats/2/info")).json();
  expect(
    (await action("group.rename", { chat_id: "2", name: "must not mutate" }))
      .status,
  ).toBe(400);
  expect((await (await app.request("/api/chats/2/info")).json()).name).toBe(
    before.name,
  );
});

test("untyped RPC failure and child exit cannot claim a mutation is safe to retry", async () => {
  for (const text of ["__internal__", "__crash__"]) {
    const form = new FormData();
    form.set("chat_id", "1");
    form.set("text", text);
    const response = await app.request("/api/messages", {
      method: "POST",
      body: form,
    });
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.retry_safe).toBe(false);
    expect(body.disposition).toBe("may_have_completed");
  }
});

test("native search saturation is explicit and scoped filtering never claims completeness", async () => {
  for (let i = 0; i < 100; i++) {
    const form = new FormData();
    form.set("chat_id", "1");
    form.set("text", `native search cap ${i}`);
    expect(
      (await app.request("/api/messages", { method: "POST", body: form }))
        .status,
    ).toBe(200);
  }
  const result = await (
    await app.request("/api/search?query=native%20search%20cap&chat_id=2")
  ).json();
  expect(result.messages).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(result.warning).toContain("100 global matches");
});

test("ROWID history has a bounded physical window and tells sparse chats to use timestamp fallback", async () => {
  const response = await app.request(
    "/api/chats/1/messages?limit=200&before_rowid=100000",
  );
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toContain("timestamp before cursor");
  expect(body.pagination_fallback).toBe(true);
});

test("dual-cursor sparse history falls back without dropping equal-timestamp rows", async () => {
  await rpc.stop();
  const previous = process.env["IMSGWEB_RPC_CMD"];
  process.env["IMSGWEB_RPC_CMD"] = `${previous} --same-timestamp`;
  try {
    const response = await app.request(
      "/api/chats/1/messages?limit=50&before_rowid=100000&before=2026-06-10T00:00:02.000Z",
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()).messages.map((m: { id: number }) => m.id),
    ).toEqual([101, 102]);
  } finally {
    await rpc.stop();
    process.env["IMSGWEB_RPC_CMD"] = previous;
  }
});

test("tracked text uses the client UUID as the outgoing GUID and rejects duplicate attempts", async () => {
  const attempt = "65cb903a-53b8-43cb-981f-85abf19d0a64";
  const form = new FormData();
  form.set("mode", "tracked");
  form.set("chat_id", "1");
  form.set("text", "tracked text");
  form.set("attempt_id", attempt);
  const response = await app.request("/api/messages", {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.attempt_id).toBe(attempt);
  expect(result.guid).toBe(attempt);
  expect(
    (await (await app.request(`/api/messages/${attempt}/status`)).json())
      .send_state,
  ).toBe("delivered");
  expect(
    (await app.request("/api/messages", { method: "POST", body: form })).status,
  ).toBe(400);
  form.set("attempt_id", "39e0a378-8371-405c-9cdc-706c5c69ad44");
  form.delete("chat_id");
  form.set("to", "+15551234567");
  expect(
    (await app.request("/api/messages", { method: "POST", body: form })).status,
  ).toBe(200);
});

test("tracked rejects absent UUIDs, invalid UUIDs and all non-text modifiers before dispatch", async () => {
  const fields: Array<[string, string | File]> = [
    ["attempt_id", "not-a-uuid"],
    ["file", new File(["a"], "a.txt")],
    ["text_formatting", "[]"],
    ["reply_to", "MOCK-101"],
    ["subject", "x"],
    ["effect_id", "confetti"],
    ["url", "https://example.com"],
    ["parts", '[{"text":"no"}]'],
    ["text", "  "],
    ["allow_sms_fallback", "true"],
  ];
  for (const field of [undefined, ...fields]) {
    const form = new FormData();
    form.set("mode", "tracked");
    form.set("chat_id", "1");
    form.set("text", "invalid tracked");
    if (field) {
      form.set("attempt_id", "50693652-6f0d-46bb-bb20-b0dcbdc5e57f");
      form.set(field[0], field[1]);
    }
    expect(
      (await app.request("/api/messages", { method: "POST", body: form }))
        .status,
    ).toBe(400);
  }
});

test("tracked is capability gated and uncertain outcomes remain unsafe without retry", async () => {
  const form = new FormData();
  form.set("mode", "tracked");
  form.set("chat_id", "1");
  form.set("attempt_id", "acb89b31-447f-4cd4-bbd6-e2e73667b0d3");
  form.set("text", "__unsafe__");
  const response = await app.request("/api/messages", {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(502);
  expect((await response.json()).retry_safe).toBe(false);
  await rpc.stop();
  const previous = process.env["IMSGWEB_RPC_CMD"];
  process.env["IMSGWEB_RPC_CMD"] = `${previous} --deny=send.tracked`;
  try {
    form.set("text", "tracked denied");
    expect(
      (await app.request("/api/messages", { method: "POST", body: form }))
        .status,
    ).toBe(503);
    expect(
      (await (await app.request("/api/search?query=tracked%20denied")).json())
        .messages,
    ).toEqual([]);
  } finally {
    await rpc.stop();
    process.env["IMSGWEB_RPC_CMD"] = previous;
  }
});
