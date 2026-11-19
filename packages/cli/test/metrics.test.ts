import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logEvent, logTurnUsage } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

/** A KB clone whose origin has a homeostat/state branch, as a sync would have fetched it. */
function clone(state?: Record<string, unknown>) {
  const kb = mkdtempSync(join(tmpdir(), "homeostat-metrics-"));
  cpSync(starter, kb, { recursive: true });
  const g = (dir: string, ...a: string[]) =>
    execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=Lee", "-c", "user.email=t@example.com", ...a],
      {
        encoding: "utf8",
      },
    );
  g(kb, "init", "-q", "-b", "main");
  g(kb, "add", "-A");
  g(kb, "commit", "-qm", "kb");
  if (!state) return kb;
  const origin = mkdtempSync(join(tmpdir(), "homeostat-metrics-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = mkdtempSync(join(tmpdir(), "homeostat-metrics-state-"));
  g(work, "init", "-q", "-b", "homeostat/state");
  for (const [path, value] of Object.entries(state)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), JSON.stringify(value));
  }
  g(work, "add", "-A");
  g(work, "commit", "-qm", "state");
  g(work, "push", "-q", origin, "homeostat/state");
  g(kb, "remote", "add", "origin", origin);
  g(kb, "fetch", "-q", "origin", "+refs/heads/homeostat/state:refs/remotes/origin/homeostat/state");
  return kb;
}

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-21T12:00:00Z"),
  };
  const code = await runCli(["node", "homeostat", "metrics", ...args], io);
  return { code, stdout, stderr };
}

const lesson = (id: string, decision: string, confidence: number, extra = {}) => ({
  member: "lee",
  id,
  title: id,
  decision,
  confidence,
  reason: "",
  ...extra,
});

describe("homeostat metrics", () => {
  test("--json prints the whole report for a clone with a state branch", async () => {
    const kb = clone({
      "runs/2026-10-20T06-00-00Z.json": {
        at: "2026-10-20T06:00:00Z",
        members: [{ member: "lee", merged: 1, review: 1, declined: 1 }],
        settled: 0,
        lessons: [
          lesson("a", "merged", 82, { source: "manual", origin: "pending" }),
          lesson("b", "review", 68),
          lesson("c", "declined", 90, { duplicateOf: "redact-before-logging" }),
        ],
        timing: {
          started: "2026-10-20T06:00:00Z",
          finished: "2026-10-20T06:02:00Z",
          modelCalls: 3,
          chars: 900,
          failedCalls: 0,
        },
      },
      "decisions/lee.json": {
        member: "lee",
        decided: [
          {
            path: "knowledge/core/a.md",
            id: "a",
            hash: "h1",
            decision: "merged",
            reason: "",
            confidence: 82,
            pr: "homeostat/daily-lee-2026-10-20",
            at: "2026-10-20T06:00:00Z",
          },
          {
            path: "knowledge/core/b.md",
            id: "b",
            hash: "h2",
            decision: "review",
            reason: "",
            confidence: 68,
            pr: "homeostat/review-lee-2026-10-20",
            at: "2026-10-20T06:00:00Z",
            openedAt: "2026-10-20T06:00:00Z",
          },
        ],
      },
    });
    logEvent(kb, {
      ts: "2026-10-21T09:00:00Z",
      type: "injection",
      session: "s1",
      source: "startup",
      ms: 150,
      ok: true,
      tokens: 120,
      entries: [{ id: "redact-before-logging", form: "full" }],
      dropped: [],
    });
    logTurnUsage(kb, {
      ts: "2026-10-21T09:05:00Z",
      session: "s1",
      turn: 1,
      calls: ["search"],
      retrieved: true,
      credited: true,
      credits: ["redact-before-logging"],
    });
    logTurnUsage(kb, {
      ts: "2026-10-21T09:10:00Z",
      session: "s1",
      turn: 2,
      calls: [],
      retrieved: false,
      credited: false,
      credits: [],
    });
    const { code, stdout } = await run(["--dir", kb, "--json"]);
    expect(code).toBe(0);
    const r = JSON.parse(stdout);
    expect(Object.keys(r)).toEqual([
      "window",
      "decisions",
      "calibration",
      "latency",
      "reach",
      "runtime",
      "usage",
      "healthTrend",
    ]);
    expect(r.usage).toMatchObject({
      turns: 2,
      retrievedShare: 0.5,
      creditedShare: 0.5,
      creditedAfterRetrieval: 1,
      distinctRules: 1,
      neverCredited: [],
    });
    expect(r.window).toMatchObject({ days: 30, runs: 30, runsOnRecord: 1 });
    expect(r.decisions.current).toMatchObject({ merged: 1, review: 1, declined: 1, duplicates: 1 });
    expect(r.calibration.bands[8]).toMatchObject({ merged: 1 });
    expect(r.latency.open).toHaveLength(1);
    expect(r.reach).toMatchObject({ sessions: 1, distinctRules: 1, reachable: 2 });
    expect(r.runtime.sessionStart).toMatchObject({ median: 150 });
    expect(r.runtime.dailyRuns[0]).toMatchObject({ durationMs: 120_000, modelCalls: 3 });

    const text = await run(["--dir", kb]);
    expect(text.stdout).toContain("Performance, last 30 days and 30 runs (1 on record)");
    for (const heading of [
      "Summary",
      "Calibration",
      "Decisions and health",
      "Reach",
      "Use",
      "Runtime",
      "Review latency",
    ])
      expect(text.stdout).toContain(`\n${heading}\n`);
    expect(text.stdout).toContain("auto-merge share       50%");
    expect(text.stdout).toContain("b                    lee, 68, waiting 30h");
    expect(text.stdout).not.toContain("no runs yet");
  });

  test("--days and --runs set the window", async () => {
    const { stdout } = await run(["--dir", clone(), "--json", "--days", "7", "--runs", "5"]);
    expect(JSON.parse(stdout).window).toMatchObject({ days: 7, runs: 5 });
  });

  test("a clone without a state branch prints the local sections and says there are no runs", async () => {
    const kb = clone();
    logEvent(kb, {
      ts: "2026-10-21T09:00:00Z",
      type: "mcp-call",
      tool: "context",
      ms: 20,
      ok: true,
    });
    const { code, stdout } = await run(["--dir", kb]);
    expect(code).toBe(0);
    expect(stdout).toContain("no runs yet");
    expect(stdout).toContain("mcp context            1 calls, 0 failed, median 20 ms");
    expect(stdout).toContain("rules served           0 of 2 reachable");
  });

  test("with no knowledge base it fails like the other read commands", async () => {
    const { code, stderr } = await run(["--dir", mkdtempSync(join(tmpdir(), "homeostat-empty-"))]);
    expect(code).toBe(1);
    expect(stderr).toContain("homeostat.yaml is missing or invalid");
  });
});

describe("homeostat metrics: the team's shared usage", () => {
  test("adds up the counts members share, next to how many share them", async () => {
    // Before, it printed only "1 of 3 members share usage counts" and this machine's figures.
    const day = (
      sessions: number,
      turns: number,
      retrievedTurns: number,
      creditedTurns: number,
    ) => ({
      sessions,
      injections: sessions,
      rules: sessions * 4,
      mcpCalls: retrievedTurns,
      docReads: 1,
      turns,
      retrievedTurns,
      creditedTurns,
    });
    const kb = clone({
      "heartbeats/dana.json": {
        member: "dana",
        at: "2026-10-21T08:00:00Z",
        kbCommit: null,
        behind: 0,
        pending: 0,
        version: "0.5.17",
        usage: { "2026-10-20": day(3, 20, 2, 1), "2026-10-21": day(2, 10, 1, 0) },
      },
    });
    const { code, stdout } = await run(["--dir", kb, "--days", "7"]);
    expect(code).toBe(0);
    expect(stdout).toContain("1 of 3 members share usage counts");
    expect(stdout).toMatch(/team sessions\s+5 over \d+ days, 20 rules injected/);
    expect(stdout).toMatch(/team lookups\s+3 MCP calls, 2 document reads/);
    expect(stdout).toMatch(/team turns\s+30: 10% looked something up, 3% credited a rule/);
  });

  test("shows which laptops run a plugin with every hook, and which an older one", async () => {
    // The CLI follows the KB's pin by itself; the plugin does not, and an older one never runs
    // the file or commit hooks. Until heartbeats said so, nobody could tell.
    const beat = (
      member: string,
      plugin?: { version: string; hooks: string[]; shell?: boolean },
    ) => ({
      member,
      at: "2026-10-21T08:00:00Z",
      kbCommit: null,
      behind: 0,
      pending: 0,
      version: "0.5.27",
      ...(plugin ? { plugin } : {}),
    });
    const every = [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "PostToolUse",
      "PreToolUse",
    ];
    const kb = clone({
      "heartbeats/dana.json": beat("dana", { version: "0.5.27", hooks: every, shell: true }),
      // Every hook event, but a file hook that does not follow shell edits yet (before 0.5.23).
      "heartbeats/kim.json": beat("kim", { version: "0.5.21", hooks: every }),
      "heartbeats/lee.json": beat("lee", {
        version: "0.5.11",
        hooks: ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"],
      }),
      "heartbeats/sam.json": beat("sam"),
    });
    const { stdout } = await run(["--dir", kb, "--days", "7"]);
    expect(stdout).toMatch(
      /plugins\s+1 of 4 laptops have every hook; older plugin \(not every moment, e\.g\. no shell edits\): kim 0\.5\.21, lee 0\.5\.11; not reported yet: sam/,
    );
  });

  test("shows when rules reached agents, and whether agents acted on them", async () => {
    const kb = clone({
      "heartbeats/dana.json": {
        member: "dana",
        at: "2026-10-21T08:00:00Z",
        kbCommit: null,
        behind: 0,
        pending: 0,
        version: "0.5.27",
        usage: {
          "2026-10-21": {
            sessions: 2,
            injections: 6,
            rules: 20,
            mcpCalls: 0,
            docReads: 0,
            moments: { start: 12, prompt: 3, file: 3, code: 1, commit: 1 },
            findings: 4,
            findingsFixed: 3,
            findingsAnswered: 1,
            commitsHeld: 2,
            commitsChanged: 1,
          },
        },
      },
    });
    const { stdout } = await run(["--dir", kb, "--days", "7"]);
    expect(stdout).toMatch(/team moments\s+start 12, prompt 3, file 3, code 1, commit 1 rules/);
    expect(stdout).toMatch(/team findings\s+4 given, 3 fixed \(75%\), 1 answered without a fix/);
    expect(stdout).toMatch(
      /team commits\s+2 held by the commit check, 1 changed before going through/,
    );
  });
});
