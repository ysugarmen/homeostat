import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readState } from "../src/state.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

/** A KB clone whose origin has a homeostat/state branch, as a sync would have fetched it. */
function clone(state?: Record<string, unknown>, candidates: Record<string, unknown> = {}) {
  const kb = mkdtempSync(join(tmpdir(), "homeostat-state-"));
  cpSync(starter, kb, { recursive: true });
  const g = (dir: string, ...a: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
      encoding: "utf8",
    });
  g(kb, "init", "-q", "-b", "main");
  g(kb, "add", "-A");
  g(kb, "commit", "-qm", "kb");
  if (!state) return kb;
  const origin = mkdtempSync(join(tmpdir(), "homeostat-state-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const work = mkdtempSync(join(tmpdir(), "homeostat-state-work-"));
  g(work, "init", "-q", "-b", "homeostat/state");
  for (const [path, value] of Object.entries(state)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), JSON.stringify(value));
  }
  g(work, "add", "-A");
  g(work, "commit", "-qm", "state");
  g(work, "push", "-q", origin, "homeostat/state");
  for (const [member, heartbeat] of Object.entries(candidates)) {
    const c = mkdtempSync(join(tmpdir(), "homeostat-state-cand-"));
    g(c, "init", "-q", "-b", `candidates/${member}`);
    mkdirSync(join(c, ".homeostat-sync"));
    writeFileSync(join(c, ".homeostat-sync/heartbeat.json"), JSON.stringify(heartbeat));
    g(c, "add", "-A");
    g(c, "commit", "-qm", "heartbeat");
    g(c, "push", "-q", origin, `candidates/${member}`);
  }
  g(kb, "remote", "add", "origin", origin);
  g(kb, "fetch", "-q", "origin", "+refs/heads/homeostat/state:refs/remotes/origin/homeostat/state");
  g(kb, "fetch", "-q", "origin", "+refs/heads/candidates/*:refs/remotes/origin/candidates/*");
  return kb;
}

const run = (at: string) => ({ at, members: [], settled: 0, lessons: [] });
const heartbeat = (at: string, pending: number) => ({
  member: "lee",
  at,
  kbCommit: null,
  behind: 0,
  pending,
  version: "0.2.1",
});

test("reads runs, decisions and the freshest heartbeat per member from the clone", () => {
  const kb = clone(
    {
      "runs/2026-10-15T06-00-00Z.json": run("2026-10-15T06:00:00Z"),
      "runs/2026-10-16T06-00-00Z.json": run("2026-10-16T06:00:00Z"),
      "decisions/lee.json": { member: "lee", decided: [] },
      "heartbeats/lee.json": heartbeat("2026-10-15T06:00:00Z", 0),
    },
    { lee: heartbeat("2026-10-16T08:00:00Z", 1) },
  );
  const s = readState(kb, 1);
  expect(s.present).toBe(true);
  // maxRuns keeps the newest runs.
  expect(s.runs.map((r) => r.at)).toEqual(["2026-10-16T06:00:00Z"]);
  // The candidates branch is fresher than the run's copy.
  expect(s.heartbeats).toEqual([heartbeat("2026-10-16T08:00:00Z", 1)]);
  expect(s.decisions).toEqual([{ member: "lee", decided: [] }]);
  expect(readState(kb).runs).toHaveLength(2);
});

test("a clone without the state branch is not present", () => {
  expect(readState(clone())).toEqual({ present: false, runs: [], heartbeats: [], decisions: [] });
});
