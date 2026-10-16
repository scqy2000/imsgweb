import { expect, test } from "bun:test";
import { mapBounded } from "./reads";
import { withStagedUpload } from "./sends";

test("preview worker pool never exceeds four outstanding requests", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapBounded(
    Array.from({ length: 100 }, (_, i) => i),
    async (value) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return value * 2;
    },
  );
  expect(peak).toBe(4);
  expect(result).toEqual(Array.from({ length: 100 }, (_, i) => i * 2));
});

test("staged uploads clean up on both successful and failed dispatch", async () => {
  for (const fail of [false, true]) {
    let staged = "";
    const result = withStagedUpload(
      new File(["bytes"], "../../test.png"),
      async (path) => {
        staged = path!;
        expect(await Bun.file(staged).text()).toBe("bytes");
        if (fail) throw new Error("dispatch failed");
        return "ok";
      },
    );
    if (fail) await expect(result).rejects.toThrow("dispatch failed");
    else expect(await result).toBe("ok");
    expect(await Bun.file(staged).exists()).toBe(false);
  }
});
