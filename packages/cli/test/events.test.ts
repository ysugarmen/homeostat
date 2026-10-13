import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEvent, LEGACY_EVENTS, logEvent, readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const repo = new URL("../../../", import.meta.url).pathname;
const kb = () => {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-ev-"));
  cpSync(join(repo, "examples/starter-kb"), dir, { recursive: true });
  return dir;
};

describe("event store (4.1)", () => {
  test("writes and reads back in order, filtered by time and type", () => {
    const dir = kb();
    logEvent(dir, {
      ts: "2026-10-14T08:00:00.000Z",
      type: "injection",
      entries: [{ id: "a" }],
      tokens: 40,
    });
    logEvent(dir, { ts: "2026-10-14T09:00:00.000Z", type: "mcp-call", tool: "search" });
    logEvent(dir, { ts: "2026-10-13T09:00:00.000Z", type: "mcp-call", tool: "explain" });
    expect(readEvents(dir).map((e) => e.ts)).toEqual([
      "2026-10-13T09:00:00.000Z",
      "2026-10-14T08:00:00.000Z",
      "2026-10-14T09:00:00.000Z",
    ]);
    expect(readEvents(dir, { since: "2026-10-14" })).toHaveLength(2);
    expect(readEvents(dir, { types: ["mcp-call"] }).map((e) => e.tool)).toEqual([
      "explain",
      "search",
    ]);
  });

  test("the earlier JSONL log is imported once", () => {
    const dir = kb();
    mkdirSync(join(dir, ".homeostat"), { recursive: true });
    writeFileSync(
      join(dir, LEGACY_EVENTS),
      `${JSON.stringify({ ts: "2026-10-01T00:00:00Z", type: "injection" })}\nnot json\n`,
    );
    expect(readEvents(dir)).toHaveLength(1);
    expect(existsSync(join(dir, LEGACY_EVENTS))).toBe(false);
    expect(readEvents(dir)).toHaveLength(1);
  });

  test("each event reads as one line", () => {
    expect(
      formatEvent({
        ts: "2026-10-14T08:00:00.000Z",
        type: "mcp-alias",
        name: "get_rules",
        resolved: "context",
      }),
    ).toBe('2026-10-14 08:00:00  mcp-alias          guessed "get_rules" → context');
  });
});

describe("a day of use produces a readable log", () => {
  test("hooks, captures, flags and agent runs all land in homeostat events", async () => {
    const dir = kb();
    const io = (out: { s: string }) => ({
      stdout: (t: string) => (out.s += t),
      stderr: () => {},
      color: false,
      env: { HOMEOSTAT_DIR: dir },
      now: () => new Date("2026-10-14T10:00:00Z"),
    });
    const sink = { s: "" };
    const code = execFileSync("git", ["-C", dir, "init", "-q"]);
    expect(code).toBeDefined();
    await runCli(["node", "homeostat", "hook", "session-start"], {
      ...io(sink),
      stdin: async () => JSON.stringify({ session_id: "s", cwd: dir }),
    });
    await runCli(
      [
        "node",
        "homeostat",
        "learn",
        "--dir",
        dir,
        "--title",
        "Pin actions",
        "--rule",
        "Pin actions to a SHA.",
        "--why",
        "Tags move.",
        "--author",
        "sam",
      ],
      io(sink),
    );
    await runCli(
      [
        "node",
        "homeostat",
        "flag",
        "redact-before-logging",
        "--dir",
        dir,
        "--by",
        "lee",
        "--reason",
        "renamed",
      ],
      io(sink),
    );
    await runCli(
      ["node", "homeostat", "deep-dive", "--dir", dir, "--no-llm", "--dry-run"],
      io(sink),
    );

    const out = { s: "" };
    await runCli(["node", "homeostat", "events", "--since", "2026-10-14"], io(out));
    const lines = out.s.trim().split("\n");
    expect(lines.map((l) => l.split(/\s+/)[2])).toEqual([
      "injection",
      "entry-created",
      "entry-flagged",
      "agent-run",
    ]);
    expect(out.s).toContain("entry-flagged      redact-before-logging by lee: renamed");
    expect(out.s).toContain("agent-run          deepDive ok:");
  });

  test("a failed agent run is logged as a failure", async () => {
    const dir = kb();
    await runCli(["node", "homeostat", "curate", "--dir", dir], {
      stdout: () => {},
      stderr: () => {},
      color: false,
      env: {},
    });
    expect(readEvents(dir, { types: ["agent-run"] })).toEqual([
      expect.objectContaining({
        agent: "curator",
        ok: false,
        summary: expect.stringContaining("set HOMEOSTAT_BITBUCKET_TOKEN"),
      }),
    ]);
  });
});

test("the real binary stays quiet: no SQLite warning in hook output", () => {
  const dir = kb();
  const result = execFileSync(
    "sh",
    [
      "-c",
      `echo '{"session_id":"q","cwd":"${dir}"}' | "${process.execPath}" "${join(repo, "packages/cli/bin/homeostat.js")}" hook session-start 2>&1 >/dev/null`,
    ],
    { encoding: "utf8", env: { ...process.env, HOMEOSTAT_DIR: dir } },
  );
  expect(result).toBe("");
});

test("injections say whether the hook or MCP put them in", () => {
  const base = {
    ts: "2026-10-14T08:00:00.000Z",
    type: "injection",
    tokens: 10,
    entries: [{ id: "a" }],
  };
  expect(formatEvent({ ...base, source: "startup" })).toContain(
    "1 rule (10 tokens) via hook (startup): a",
  );
  expect(formatEvent({ ...base, source: "mcp" })).toContain("via MCP: a");
});
