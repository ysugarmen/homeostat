import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  candidatesBranch,
  type DecisionRecord,
  type DecisionsFile,
  decisionsPath,
  HEARTBEAT_PATH,
  type Heartbeat,
  lessonHash,
  readKbFiles,
  readPendingFiles,
  removePendingFile,
  STATE_BRANCH,
  VERSION,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { commitTree, forcePush, git } from "./git.ts";
import { memberIdFrom } from "./init.ts";

/**
 * Keeps one developer's KB clone in step with the team, with no scheduler on the laptop: the
 * plugin's hooks call it in the background when a session starts, when a message is sent (at most
 * every few hours) and when a reply finishes with lessons unsent. One run:
 *
 * 1. fetches the base branch, the daily run's state branch and this developer's candidates branch
 * 2. clears pending lessons the daily run has decided (merged or declined), keeping a notice
 * 3. fast-forwards the clone when its tracked files are clean
 * 4. force-pushes the base branch + pending lessons + a heartbeat to `candidates/<member>`
 */
export interface SyncOptions {
  dir?: string;
  quiet?: boolean;
  /** Skip the pull; used right after a lesson is written. */
  pushOnly?: boolean;
}

export interface Notice {
  at: string;
  text: string;
}

export interface SyncState {
  lastSync?: string;
  lastHeartbeat?: string;
  /** Fingerprint of the pending set last pushed. */
  pushed?: string;
  /** Notices not yet shown in a session. */
  unseen?: Notice[];
}

const STATE_FILE = ".homeostat/sync.json";
const HEARTBEAT_EVERY_MS = 12 * 3_600_000;

export function readSyncState(root: string): SyncState {
  try {
    return JSON.parse(readFileSync(join(root, STATE_FILE), "utf8")) as SyncState;
  } catch {
    return {};
  }
}

export function writeSyncState(root: string, state: SyncState) {
  mkdirSync(join(root, ".homeostat"), { recursive: true });
  writeFileSync(join(root, STATE_FILE), `${JSON.stringify(state, null, 1)}\n`);
}

/** Identifies the current pending set; a change means there is something new to push. */
export function pendingFingerprint(root: string): string {
  const pending = readPendingFiles(root);
  return lessonHash(
    Object.keys(pending)
      .sort()
      .map((p) => `${p}:${lessonHash(pending[p] ?? "")}`)
      .join("\n"),
  );
}

const idOf = (path: string) => path.split("/").at(-1)?.replace(/\.md$/, "") ?? path;

export async function runSync(opts: SyncOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const say = (s: string) => {
    if (!opts.quiet) io.stdout(s);
  };
  const config = validate(readKbFiles(root)).config;
  if (!config) {
    io.stderr("homeostat.yaml is missing or invalid; run homeostat validate\n");
    return 1;
  }
  if (git(root, "remote", "get-url", "origin") === undefined) {
    say("no origin remote: lessons stay local\n");
    return 0;
  }
  const base = config.sources?.baseBranch ?? "main";
  const now = (io.now?.() ?? new Date()).toISOString();
  const member = memberIdFrom(git(root, "config", "user.name"));
  const isMember = config.team.members.some((m) => m.id === member);
  const state = readSyncState(root);
  const notices: Notice[] = [];

  // 1. Fetch. A branch that does not exist yet (no daily run so far) is fine.
  git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
  git(
    root,
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${STATE_BRANCH}:refs/remotes/origin/${STATE_BRANCH}`,
  );

  // 2. Clear what the daily run has decided.
  const raw = git(root, "show", `refs/remotes/origin/${STATE_BRANCH}:${decisionsPath(member)}`);
  const decided = new Map<string, DecisionRecord>();
  if (raw) {
    try {
      for (const d of (JSON.parse(raw) as DecisionsFile).decided) decided.set(d.hash, d);
    } catch {
      // A torn or foreign file: decide nothing rather than fail the sync.
    }
  }
  for (const [path, text] of Object.entries(readPendingFiles(root))) {
    const d = decided.get(lessonHash(text));
    if (!d || d.decision === "review") continue;
    removePendingFile(root, path);
    notices.push({
      at: now,
      text:
        d.decision === "merged"
          ? `${d.id}: merged into the team KB`
          : `${d.id}: declined (${d.reason})`,
    });
  }

  // 3. Fast-forward when the tracked files are clean and the clone is on the base branch.
  let behind = 0;
  if (!opts.pushOnly) {
    const onBase = git(root, "rev-parse", "--abbrev-ref", "HEAD") === base;
    const clean = (git(root, "status", "--porcelain", "--untracked-files=no") ?? "x") === "";
    const ahead = Number(
      git(root, "rev-list", "--count", `HEAD..refs/remotes/origin/${base}`) ?? 0,
    );
    if (ahead > 0) {
      if (
        onBase &&
        clean &&
        git(root, "merge", "--ff-only", "--quiet", `refs/remotes/origin/${base}`) !== undefined
      ) {
        say(`pulled ${ahead} commit${ahead === 1 ? "" : "s"}\n`);
      } else {
        behind = ahead;
        notices.push({
          at: now,
          text: `your KB clone is ${ahead} commit${ahead === 1 ? "" : "s"} behind: ${onBase ? "tracked files have local changes" : `it is not on ${base}`}; run homeostat sync to see`,
        });
      }
    }
  }

  // 4. Push pending lessons and a heartbeat when something changed, or the heartbeat is old.
  const fp = pendingFingerprint(root);
  const heartbeatDue =
    !state.lastHeartbeat || Date.parse(now) - Date.parse(state.lastHeartbeat) > HEARTBEAT_EVERY_MS;
  let pushed = state.pushed;
  let lastHeartbeat = state.lastHeartbeat;
  const baseRef = git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`);
  if (isMember && baseRef && (fp !== state.pushed || heartbeatDue)) {
    const pending = readPendingFiles(root);
    const heartbeat: Heartbeat = {
      member,
      at: now,
      kbCommit: git(root, "rev-parse", "HEAD") ?? null,
      behind,
      pending: Object.keys(pending).length,
      version: VERSION,
    };
    try {
      const commit = commitTree(
        root,
        baseRef,
        { ...pending, [HEARTBEAT_PATH]: `${JSON.stringify(heartbeat, null, 1)}\n` },
        `homeostat: ${Object.keys(pending).length} pending lesson(s) from ${member}`,
      );
      forcePush(root, commit, candidatesBranch(member));
      pushed = fp;
      lastHeartbeat = now;
      say(`sent ${Object.keys(pending).length} pending lesson(s) to ${candidatesBranch(member)}\n`);
    } catch (e) {
      say(`could not push ${candidatesBranch(member)}: ${(e as Error).message}\n`);
    }
  }

  for (const n of notices) say(`${n.text}\n`);
  writeSyncState(root, {
    lastSync: now,
    ...(lastHeartbeat ? { lastHeartbeat } : {}),
    ...(pushed ? { pushed } : {}),
    unseen: [...(state.unseen ?? []), ...notices].slice(-20),
  });
  return 0;
}

/** Whether a background sync is due: none yet, older than `hours`, or unsent lessons. */
export function syncDue(root: string, now: Date, hours: number): boolean {
  if (!existsSync(join(root, ".homeostat"))) return true;
  const s = readSyncState(root);
  if (!s.lastSync || now.getTime() - Date.parse(s.lastSync) > hours * 3_600_000) return true;
  return pendingFingerprint(root) !== s.pushed && Object.keys(readPendingFiles(root)).length > 0;
}

/** Takes the notices a session has not shown yet, and marks them shown. */
export function takeNotices(root: string): Notice[] {
  const s = readSyncState(root);
  if (!s.unseen?.length) return [];
  writeSyncState(root, { ...s, unseen: [] });
  return s.unseen;
}

export const idFromPath = idOf;
