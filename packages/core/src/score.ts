import { type Config, isSenior, type Weights } from "./config.ts";
import type { Frontmatter, SourceType } from "./schema.ts";

export interface ScoreContext {
  config: Config;
  /** Open "this is wrong" flags; defaults to the entry's `flags`. */
  flags?: number;
}

export interface ScoreReason {
  signal: keyof Weights;
  delta: number;
  note: string;
}

export interface ScoreResult {
  score: number;
  reasons: ScoreReason[];
}

const BASE_SIGNAL: Record<Exclude<SourceType, "pr-feedback">, keyof Weights> = {
  manual: "manual",
  "agent-handoff": "agentHandoff",
  "deep-dive": "deepDive",
};

/**
 * Computes an entry's score from its source, its author's seniority, conflicts and flags, using
 * the weights in the config. Pure; `validate()` compares the result with the stored `score`.
 */
export function score(entry: Frontmatter, ctx: ScoreContext): ScoreResult {
  const { weights } = ctx.config.scoring;
  const reasons: ScoreReason[] = [];
  const add = (signal: keyof Weights, note: string, times = 1) => {
    const delta = weights[signal] * times;
    if (delta !== 0) reasons.push({ signal, delta, note });
  };

  const { source } = entry;
  if (source.type === "pr-feedback") {
    if (source.changedCode) add("prFeedbackChangedCode", "review comment led to a code change");
    else add("prFeedback", "review comment without a follow-up code change");
  } else {
    add(BASE_SIGNAL[source.type], `source is ${source.type}`);
  }

  const author = ctx.config.team.members.find((m) => m.id === source.author);
  if (author && isSenior(author.role)) add("seniorAuthor", `author ${author.id} is ${author.role}`);

  if (entry.conflictsWith?.length) {
    add("conflict", `conflicts with ${entry.conflictsWith.join(", ")}`);
  }

  const flags = ctx.flags ?? entry.flags?.length ?? 0;
  if (flags > 0) add("flag", `${flags} open flag${flags === 1 ? "" : "s"}`, flags);

  return { score: reasons.reduce((sum, r) => sum + r.delta, 0), reasons };
}
