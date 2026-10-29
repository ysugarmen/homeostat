import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendingCapError, validate } from "@homeostat/core";
import { expect, test } from "vitest";
import { askerFor, capLine, formatRunUse, newRunStats, runCost } from "../src/agents.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;

test("the asker counts its calls, their size and failures for the run report", async () => {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if ((f.endsWith(".md") || f.endsWith(".yaml")) && f !== "README.md")
      files[f] = readFileSync(join(starter, f), "utf8");
  }
  const config = validate(files).config;
  if (!config) throw new Error("config");
  const stats = { calls: 0, chars: 0, failed: 0 };
  // No credential in the environment: the API runtime refuses before any request is sent.
  const ask = askerFor(
    config,
    "curator",
    { stdout: () => {}, stderr: () => {}, color: false, env: {} },
    mkdtempSync(join(tmpdir(), "homeostat-asker-")),
    stats,
  );
  // The schema is never reached: the call fails on credentials first.
  await expect(ask("system", "user text", {} as never)).rejects.toThrow();
  expect(stats).toMatchObject({
    calls: 1,
    chars: "system".length + "user text".length,
    failed: 1,
    byAgent: { curator: { calls: 1 } },
  });
});

test("past the spending cap no call starts; tokens without a cost are priced as an estimate", async () => {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if ((f.endsWith(".md") || f.endsWith(".yaml")) && f !== "README.md")
      files[f] = readFileSync(join(starter, f), "utf8");
  }
  const config = validate(files).config;
  if (!config) throw new Error("config");
  const stats = newRunStats(0.05);
  let sent = 0;
  const ask = askerFor(
    config,
    "curator",
    {
      stdout: () => {},
      stderr: () => {},
      color: false,
      env: {},
      // Opus 5.5: 10k in and 2k out is $0.08, a reported cost is taken as given.
      runtime:
        ({ onUsage }) =>
        async () => {
          sent++;
          onUsage({
            inputTokens: 10_000,
            outputTokens: 2_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            ...(sent === 2 ? { costUsd: 0.01 } : {}),
          });
          return {} as never;
        },
    },
    mkdtempSync(join(tmpdir(), "homeostat-asker-")),
    stats,
  );
  await ask("s", "u", {} as never);
  expect(runCost(stats)).toEqual({ usd: 0.08, estimated: true });
  await expect(ask("s", "u", {} as never)).rejects.toBeInstanceOf(SpendingCapError);
  expect(sent).toBe(1);
  expect(stats.capped).toBe(true);
  expect(stats.calls).toBe(1);
  expect(capLine(stats, 3)).toBe(
    "stopped at the spending cap: $0.08 of $0.05 (estimated from tokens); 3 lessons left for the next run",
  );
});

test("a run ends with its model use per agent, and the cost where the runtime gives one", () => {
  const use = (model: string, calls: number, costUsd?: number) => ({
    model,
    calls,
    inputTokens: 1_200_000,
    outputTokens: 80_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });
  expect(
    formatRunUse({
      calls: 130,
      chars: 0,
      failed: 0,
      byAgent: {
        curator: use("claude-sonnet-5-5", 100, 3.1),
        judge: use("claude-haiku-4-5-20251001", 30, 0.4),
      },
    }),
  ).toBe(
    "model use: 130 calls, about $3.50 at API prices\n" +
      "  curator (claude-sonnet-5-5): 100 calls, 1.2M in, 80k out, $3.10\n" +
      "  judge (claude-haiku-4-5-20251001): 30 calls, 1.2M in, 80k out, $0.40\n",
  );
  expect(formatRunUse({ calls: 0, chars: 0, failed: 0, byAgent: {} })).toBe("");
});
