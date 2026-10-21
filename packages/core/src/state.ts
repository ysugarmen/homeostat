import { execFileSync } from "node:child_process";
import {
  type DecisionsFile,
  HEARTBEAT_PATH,
  type Heartbeat,
  type RunReport,
  STATE_BRANCH,
} from "./automation.ts";

/**
 * What the daily run has written to the `homeostat/state` branch, read from the clone's copy
 * (`origin/homeostat/state`), which every sync fetches. Reading it makes no network call: it is as
 * current as this clone's last sync. The dashboard, `homeostat metrics` and the doctor use it.
 */
export interface StateView {
  /** False when no daily run has written the state branch yet (or this clone never fetched it). */
  present: boolean;
  /** Oldest first, at most `maxRuns`. */
  runs: RunReport[];
  heartbeats: Heartbeat[];
  decisions: DecisionsFile[];
}

const REF = `refs/remotes/origin/${STATE_BRANCH}`;
const CANDIDATES = "refs/remotes/origin/candidates/";

function git(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function json<T>(dir: string, path: string): T | undefined {
  try {
    return JSON.parse(git(dir, "show", `${REF}:${path}`) ?? "") as T;
  } catch {
    return undefined;
  }
}

export function readState(kbRoot: string, maxRuns = 30): StateView {
  const listing = git(kbRoot, "ls-tree", "-r", "--name-only", REF);
  if (listing === undefined) return { present: false, runs: [], heartbeats: [], decisions: [] };
  const paths = listing.split("\n").filter(Boolean);
  const under = (dir: string) =>
    paths.filter((p) => p.startsWith(`${dir}/`) && p.endsWith(".json"));
  const runs = under("runs")
    .sort()
    .slice(-maxRuns)
    .flatMap((p) => json<RunReport>(kbRoot, p) ?? []);
  // The daily run's copy of each heartbeat is as old as the run; each developer's candidates
  // branch has the latest one their sync pushed (sync fetches them all). Keep the newer.
  const latest = new Map<string, Heartbeat>();
  const fresher = (h: Heartbeat | undefined) => {
    if (!h?.member) return;
    const known = latest.get(h.member);
    if (!known || h.at > known.at) latest.set(h.member, h);
  };
  for (const p of under("heartbeats")) fresher(json<Heartbeat>(kbRoot, p));
  const branches = git(kbRoot, "for-each-ref", "--format=%(refname)", CANDIDATES) ?? "";
  for (const ref of branches.split("\n").filter(Boolean)) {
    try {
      fresher(JSON.parse(git(kbRoot, "show", `${ref}:${HEARTBEAT_PATH}`) ?? "") as Heartbeat);
    } catch {
      // A candidates branch without a heartbeat: skip it.
    }
  }
  const heartbeats = [...latest.values()];
  const decisions = under("decisions").flatMap((p) => json<DecisionsFile>(kbRoot, p) ?? []);
  return { present: true, runs, heartbeats, decisions };
}
