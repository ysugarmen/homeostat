import { describe, expect, test } from "vitest";
import { startPool } from "../src/curator/curate.ts";

describe("startPool", () => {
  test("runs at most `limit` at once, starts in order, and keeps each result in its place", async () => {
    let active = 0;
    let most = 0;
    const started: number[] = [];
    const results = startPool([30, 10, 20, 5, 15], 2, async (ms) => {
      started.push(ms);
      most = Math.max(most, ++active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return ms * 2;
    });
    expect(await Promise.all(results)).toEqual([60, 20, 40, 10, 30]);
    expect(started).toEqual([30, 10, 20, 5, 15]);
    expect(most).toBe(2);
  });

  test("starts nothing more once go() is false; a failure stays with its own item", async () => {
    let stop = false;
    const results = startPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        if (n === 2) {
          stop = true;
          throw new Error("cap");
        }
        return n;
      },
      () => !stop,
    );
    expect(await results[0]).toBe(1);
    await expect(results[1]).rejects.toThrow("cap");
    // Never awaited would be fine too: the pool marks every promise handled.
    expect(await results[2]).toBeUndefined();
    expect(await results[3]).toBeUndefined();
  });
});
