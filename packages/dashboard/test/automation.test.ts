import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionsFile, Heartbeat, RunReport } from "@homeostat/core";
import { afterAll, describe, expect, test } from "vitest";
import { automationView, readAutomation } from "../src/automation.ts";
import { startDashboard } from "../src/server.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const NOW = new Date("2026-10-16T12:00:00Z");
const closers: (() => void)[] = [];
afterAll(() => {
  for (const c of closers) c();
});

/** A KB clone whose origin has a homeostat/state branch, as a sync would have fetched it. */
function clone(state?: Record<string, unknown>) {
  const kb = mkdtempSync(join(tmpdir(), "homeostat-dash-auto-"));
  cpSync(starter, kb, { recursive: true });
  const g = (dir: string, ...a: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
      encoding: "utf8",
    });
  g(kb, "init", "-q", "-b", "main");
  g(kb, "add", "-A");
  g(kb, "commit", "-qm", "kb");
  if (!state) return kb;
  const origin = mkdtempSync(join(tmpdir(), "homeostat-dash-auto-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = mkdtempSync(join(tmpdir(), "homeostat-dash-auto-state-"));
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

const run = (
  at: string,
  members: RunReport["members"],
  settled = 0,
  skipped?: RunReport["skipped"],
): RunReport => ({
  at,
  members,
  settled,
  lessons: [],
  ...(skipped ? { skipped } : {}),
});
const heartbeat = (member: string, at: string, extra: Partial<Heartbeat> = {}): Heartbeat => ({
  member,
  at,
  kbCommit: "abc",
  behind: 0,
  pending: 1,
  version: "0.1.1",
  ...extra,
});
const decisions: DecisionsFile = {
  member: "lee",
  decided: [
    {
      path: "knowledge/frontend/a.md",
      id: "use-the-shared-button-component",
      hash: "1",
      decision: "review",
      reason: "confidence 62, between 35 and 70",
      confidence: 62,
      pr: "homeostat/review-lee-2026-10-12",
      at: "2026-10-12T06:00:00Z",
    },
    {
      path: "knowledge/frontend/b.md",
      id: "prefer-css-grid",
      hash: "2",
      decision: "review",
      reason: "confidence 55",
      pr: "homeostat/review-lee-2026-10-16",
      at: "2026-10-16T06:00:00Z",
    },
    {
      path: "knowledge/frontend/c.md",
      id: "old-merged",
      hash: "3",
      decision: "merged",
      reason: "confidence 80",
      at: "2026-10-15T06:00:00Z",
    },
  ],
};
const STATE = {
  "runs/2026-10-15.json": run("2026-10-15T06:00:00Z", [
    { member: "lee", merged: 1, review: 1, declined: 0 },
  ]),
  "runs/2026-10-16.json": run(
    "2026-10-16T06:00:00Z",
    [
      {
        member: "lee",
        merged: 2,
        review: 1,
        declined: 1,
        dailyPr: "https://github.com/acme/team-kb/pull/11",
        reviewPr: "https://github.com/acme/team-kb/pull/12",
      },
      { member: "sam", merged: 0, review: 0, declined: 0, mergeError: "protected" },
    ],
    1,
    [{ url: "https://github.com/acme/web/pull/7#discussion_r1", reason: "marked homeostat:skip" }],
  ),
  "heartbeats/lee.json": heartbeat("lee", "2026-10-16T09:00:00Z", { behind: 2 }),
  "heartbeats/sam.json": heartbeat("sam", "2026-10-13T09:00:00Z"),
  "decisions/lee.json": decisions,
};

describe("the Automation page (automation, step 5)", () => {
  test("reads runs, heartbeats and decisions from the clone's copy of the state branch", () => {
    const kb = clone(STATE);
    const state = readAutomation(kb);
    expect(state.present).toBe(true);
    expect(state.runs.map((r) => r.at)).toEqual(["2026-10-15T06:00:00Z", "2026-10-16T06:00:00Z"]);
    const config = {
      team: {
        members: [
          { id: "dana", role: "senior" },
          { id: "lee", role: "member" },
          { id: "sam", role: "senior" },
        ],
      },
    };
    const v = automationView(state, config as never, NOW);
    expect(v.health.map((h) => [h.member, h.state])).toEqual([
      ["dana", "never"],
      ["lee", "ok"],
      ["sam", "stale"],
    ]);
    // Oldest first; only review decisions; the one waiting 4 days is overdue.
    expect(v.queue.map((q) => [q.id, q.overdue])).toEqual([
      ["use-the-shared-button-component", true],
      ["prefer-css-grid", false],
    ]);
    expect(v.byDay).toEqual([
      { day: "2026-10-15", merged: 1, review: 1, declined: 0 },
      { day: "2026-10-16", merged: 2, review: 1, declined: 1 },
    ]);
  });

  test("renders the page, linked from the nav", async () => {
    const kb = clone(STATE);
    const started = await startDashboard({ kbRoot: kb, port: 0, now: () => NOW });
    closers.push(() => started.server.close());
    const html = await (await fetch(`${started.url}/automation`)).text();
    expect(html).toContain('<a href="/automation" aria-current="page">Automation</a>');
    expect(html).toContain("Last daily run");
    expect(html).toContain("use-the-shared-button-component");
    expect(html).toContain("homeostat/review-lee-2026-10-12");
    expect(html).toContain(
      'Not syncing: <span class="mono">dana</span>, <span class="mono">sam</span>',
    );
    expect(html).toContain("2 behind");
    expect(html).toContain('<a href="https://github.com/acme/team-kb/pull/11">daily</a>');
    expect(html).not.toContain("old-merged");
    expect(html).toContain("1 review thread read with no lesson");
    expect(html).toContain("acme/web/pull/7#discussion_r1</a>: marked homeostat:skip");
  });

  test("before any daily run, the page says what will appear and why", async () => {
    const kb = clone();
    expect(readAutomation(kb).present).toBe(false);
    const started = await startDashboard({ kbRoot: kb, port: 0, now: () => NOW });
    closers.push(() => started.server.close());
    const html = await (await fetch(`${started.url}/automation`)).text();
    expect(html).toContain("No daily run on record in this clone yet");
  });
});
