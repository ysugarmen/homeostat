import { createHash } from "node:crypto";
import type { KbSnapshot } from "./metrics/health-trend.ts";

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

/**
 * The branch a KB branch's daily run keeps its history on (decisions, runs, heartbeats). One per
 * base branch: a trial KB on another branch must neither settle nor count the main KB's review
 * PRs, which it once did and marked lessons merged elsewhere as declined. `main` keeps the
 * original name, so existing KBs keep their history.
 */
export function stateBranch(base = "main"): string {
  return base === "main" ? STATE_BRANCH : `${STATE_BRANCH}-${base.replace(/[^\w.-]+/g, "-")}`;
}
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
  /** When the record was first written, which is when its review PR opened; for review latency. */
  openedAt?: string;
  /** When a reviewer's merge or close was recorded: the host's merge time when it has one. */
  settledAt?: string;
}

export interface DecisionsFile {
  member: string;
  decided: DecisionRecord[];
}

/** One day's usage counts from a member's event log; counts only, never ids or paths. */
export interface UsageDay {
  /** Distinct session ids that logged an injection. */
  sessions: number;
  injections: number;
  /** Rules injected, summed over the day's injections. */
  rules: number;
  mcpCalls: number;
  docReads: number;
  /** User turns recorded by the Stop hook, those that retrieved, and those that credited. */
  turns?: number;
  retrievedTurns?: number;
  creditedTurns?: number;
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
  /**
   * The last seven days' counts by day, only when the member opted in (`usage: true` on their
   * member entry, or HOMEOSTAT_SHARE_USAGE=1). Off by default: it is the one usage figure that
   * leaves a laptop.
   */
  usage?: Record<string, UsageDay>;
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
    /** Review PRs opened this run for disputed rules. */
    disputePrs?: string[];
    mergeError?: string;
    /** Why the host refused to request the reviewers, e.g. they are not collaborators. */
    reviewError?: string;
  }[];
  /** Review PRs from earlier runs that a reviewer merged or closed since. */
  settled: number;
  /** Review threads read this run that gave no lesson, and why (one-off, skip marker, too long...). */
  skipped?: { url: string; reason: string }[];
  lessons: {
    member: string;
    id: string;
    /** What the lesson said, so a decision can be checked after its text is gone. */
    title?: string;
    rule?: string;
    url?: string;
    decision: Decision;
    confidence?: number;
    reason: string;
    /** The entry's `source.type` (`doc` for a document patch), for decisions by source. */
    source?: string;
    /** Whether the lesson came from the developer's pending set or from a review on their PR. */
    origin?: "pending" | "review";
    /** The accepted rule this lesson repeated, when it was declined as a duplicate. */
    duplicateOf?: string;
  }[];
  /** The run's own cost: wall time and the model calls it made. */
  timing?: {
    started: string;
    finished: string;
    modelCalls: number;
    chars: number;
    failedCalls: number;
    /** Per agent (curator, judge): model, calls, tokens, and the runtime's cost estimate. */
    byAgent?: Record<
      string,
      {
        model: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd?: number;
      }
    >;
  };
  /** The KB's health after the run's merges, for the trend over runs. */
  kb?: KbSnapshot;
}

/** Review items older than this are repeated in the morning notice and marked on the dashboard. */
export const REVIEW_REMINDER_DAYS = 2;
/** A developer whose sync has not reported for this long is shown as not syncing. */
export const STALE_HEARTBEAT_HOURS = 48;
