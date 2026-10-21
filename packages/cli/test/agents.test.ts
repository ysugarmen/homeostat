import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@homeostat/core";
import { expect, test } from "vitest";
import { askerFor } from "../src/agents.ts";

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
  expect(stats).toEqual({ calls: 1, chars: "system".length + "user text".length, failed: 1 });
});
