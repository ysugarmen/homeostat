import { createHash } from "node:crypto";

/**
 * Shared names for the automated daily flow (local pending lessons → one daily PR per developer
 * → a decision by confidence score). Laptops and the daily run talk only through git refs on the
 * KB repo's origin, so nothing needs a service:
 *
 * - `candidates/<member>`: the base branch plus that developer's pending lessons and a heartbeat,
 *   force-pushed by the developer's sync. Transport only; never merged.
 * - `homeostat/state`: written by the daily run: each developer's decisions, collected heartbeats
 *   and one report per run. Laptops read their decisions from it; the dashboard reads all of it.
 */
export const STATE_BRANCH = "homeostat/state";
export const candidatesBranch = (member: string) => `candidates/${member}`;
export const HEARTBEAT_PATH = ".homeostat-sync/heartbeat.json";
export const decisionsPath = (member: string) => `decisions/${member}.json`;

/** Identifies one version of a lesson file, so a decision applies to exactly what was submitted. */
export const lessonHash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export type Decision = "merged" | "declined" | "review";

export interface DecisionRecord {
  path: string;
  id: string;
  hash: string;
  decision: Decision;
  /** Why: the score breakdown summary, or the reviewer's action. */
  reason: string;
  confidence?: number;
  pr?: string;
  at: string;
}

export interface DecisionsFile {
  member: string;
  decided: DecisionRecord[];
}

export interface Heartbeat {
  member: string;
  at: string;
  /** The base-branch commit the developer's clone was on after the sync. */
  kbCommit: string | null;
  /** Commits the clone could not fast-forward (local edits in the way), 0 when current. */
  behind: number;
  pending: number;
  version: string;
}

/** One daily run, written to `runs/<date>.json` on the state branch. */
export interface RunReport {
  at: string;
  members: {
    member: string;
    merged: number;
    declined: number;
    review: number;
    dailyPr?: string;
    reviewPr?: string;
    mergeError?: string;
    /** Why the host refused to request the reviewers, e.g. they are not collaborators. */
    reviewError?: string;
  }[];
  /** Review PRs from earlier runs that a reviewer merged or closed since. */
  settled: number;
  lessons: {
    member: string;
    id: string;
    decision: Decision;
    confidence?: number;
    reason: string;
  }[];
}

/** Review items older than this are repeated in the morning notice and marked on the dashboard. */
export const REVIEW_REMINDER_DAYS = 2;
/** A developer whose sync has not reported for this long is shown as not syncing. */
export const STALE_HEARTBEAT_HOURS = 48;
