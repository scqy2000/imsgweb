import { expect, test } from "bun:test";
import { HistoryRequests } from "./history";

test("refresh waits for older history before replacing it with latest messages", async () => {
  const requests = new HistoryRequests();
  let finishOlder!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishOlder = resolve;
  });
  let page = "existing latest";
  const calls: string[] = [];
  const older = requests.run(1, async () => {
    calls.push("older");
    await gate;
    page = "older page";
  });
  await Promise.resolve();
  const latest = requests.replace(1, async () => {
    calls.push("latest");
    page = "new latest";
  });
  await Promise.resolve();
  expect(page).toBe("existing latest");
  expect(calls).toEqual(["older"]);
  finishOlder();
  await Promise.all([older, latest]);
  expect(page).toBe("new latest");
  expect(calls).toEqual(["older", "latest"]);
});

test("a failed older request does not prevent a queued refresh", async () => {
  const requests = new HistoryRequests();
  const older = requests.run(1, async () => {
    throw new Error("failed page");
  });
  const next = requests.replace(1, async () => {});
  await expect(older).rejects.toThrow("failed page");
  await expect(next).resolves.toBeUndefined();
});

test("refresh and search replacements queued together each run in order", async () => {
  const requests = new HistoryRequests();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const older = requests.run(1, async () => {
    calls.push("older");
    await gate;
  });
  const latest = requests.replace(1, async () => {
    calls.push("latest");
  });
  const context = requests.replace(1, async () => {
    calls.push("context");
  });
  release();
  await Promise.all([older, latest, context]);
  expect(calls).toEqual(["older", "latest", "context"]);
});
