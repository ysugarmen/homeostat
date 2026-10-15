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
