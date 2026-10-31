import { z } from "zod";
import type { Asker } from "../claude.ts";
import type { ReviewThread } from "./threads.ts";

/**
 * A strict judge for drafted rules. The daily run drafts rules from review threads and merges the
 * confident ones with no person reading them, so a draft that says more than its thread (a value
 * the reviewer never gave, a wider scope, a one-off turned into "always") would reach every
 * session unread. Before such a draft merges, a second model checks it against the redacted thread
 * for named traps.
 *
 * Adapted from vectorize-io/hindsight, MIT (`hindsight-system-evals/hindsight_system_evals/
 * judge.py` and its trap criteria): the judge is a different model from the one under test, it
 * answers in a fixed JSON shape, and a single verdict is noisy, so the verdict that would change
 * the outcome is re-asked and kept only when the majority agrees. For a trap the side to confirm
 * flips: a trap hit is the failure, so a hit is what gets re-asked, and a pass costs one call.
 */

export const JUDGE_TRAPS = [
  "invented-detail",
  "wider-scope",
  "overgeneralised",
  "contradicts-thread",
] as const;
export type JudgeTrap = (typeof JUDGE_TRAPS)[number];

export interface JudgeProblem {
  trap: JudgeTrap;
  /** The draft's words that hit the trap, and what the thread says instead. */
  evidence: string;
}

export interface JudgeVerdict {
  ok: boolean;
  problems: JudgeProblem[];
}

export interface JudgeInput {
  /** The thread the rule was drafted from, already redacted. */
  thread: ReviewThread;
  /** The rule as it would merge. */
  draft: { title: string; rule: string; why: string; scope: readonly string[] };
  /** For an update: the rule it rewrites, whose content the rewrite may keep. */
  updates?: { title: string; rule: string; why: string };
}

/** One judge call; null when the model gave no usable answer. */
export interface DraftJudge {
  judge(input: JudgeInput): Promise<JudgeVerdict | null>;
}

export const draftJudgeSchema = z.object({
  ok: z
    .boolean()
    .describe("true only when the draft hits none of the traps; false when it hits any"),
  problems: z
    .array(
      z.object({
        trap: z.enum(JUDGE_TRAPS).describe("which trap the draft hits"),
        evidence: z
          .string()
          .describe("quote the draft's words that hit it, then what the thread says instead"),
      }),
    )
    .describe("one item per trap hit; empty when ok"),
});

export const DRAFT_JUDGE_SYSTEM = `You check a coding rule that another model drafted from one code-review thread, before it is given to every AI coding agent on a team with no person reading it. You are strict: anything in the rule that the thread does not support is a problem, because agents treat every detail in a rule as fact.

Check the rule (title, rule and why) against these traps only. Where the rule applies is set by the team's areas, not by the draft, and is not shown: do not judge it.

- invented-detail: the rule states a value, name, identifier, path, package, number, version or reason that does not appear in the thread (or, for an update, in the rule it updates). A general word is not a detail; a specific one the thread never gives is.
- wider-scope: the rule's own words claim more than the thread addressed: other services, languages, layers or situations the thread did not talk about ("every call site across all services", "in any language"). Applying the thread's point to similar code in the same part of the codebase is the purpose of a rule and is not wider scope.
- overgeneralised: the thread makes a one-off or conditional suggestion ("maybe", "here", "in this case", "consider") and the rule turns it into "always" or "never".
- contradicts-thread: the rule says the opposite of what the thread asked for or concluded, or keeps something a later reply withdrew.

Do not judge style, length or usefulness. Generalising the thread's own point into a rule for future pull requests is expected and is not a problem by itself; adding facts is. When the rule passes, set ok to true and list no problems. When it hits a trap, set ok to false and give one problem per trap, quoting the rule's words and saying what the thread says instead.`;

/** The user turn: the thread, as the drafter saw it, then the rule to check. */
export function draftJudgePrompt(input: JudgeInput): string {
  const { thread, draft, updates } = input;
  const location = thread.root.path
    ? `${thread.root.path}${thread.root.line ? `:${thread.root.line}` : ""}`
    : "the pull request as a whole";
  const conversation = [thread.root, ...thread.replies]
    .map((c) => `${c.author.id}: ${c.body.trim()}`)
    .join("\n\n");
  return `Repository: ${thread.repo}
Pull request: ${thread.pullRequest.title}
Comment on: ${location}
The author changed the code after this feedback.

<thread>
${conversation}
</thread>
${
  updates
    ? `
The draft rewrites this existing rule, so its content is allowed too:

<existing-rule>
Title: ${updates.title}
Rule: ${updates.rule}
Why: ${updates.why}
</existing-rule>
`
    : ""
}
<draft>
Title: ${draft.title}
Rule: ${draft.rule}
Why: ${draft.why}
</draft>`;
}

/**
 * Normalises one answer. A verdict that says ok but lists problems, or says not ok with none, is
 * a failure: the judge is there to stop a rule, so an inconsistent answer must not pass it.
 */
export function parseJudgeVerdict(raw: unknown): JudgeVerdict | null {
  const parsed = draftJudgeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const problems = parsed.data.problems
    .map((p) => ({ trap: p.trap, evidence: p.evidence.trim() }))
    .filter((p) => p.evidence);
  if (parsed.data.ok && problems.length === 0) return { ok: true, problems: [] };
  return {
    ok: false,
    problems: problems.length
      ? problems
      : [{ trap: "invented-detail", evidence: "the judge failed the rule without evidence" }],
  };
}

export class ClaudeDraftJudge implements DraftJudge {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async judge(input: JudgeInput): Promise<JudgeVerdict | null> {
    const out = await this.ask(DRAFT_JUDGE_SYSTEM, draftJudgePrompt(input), draftJudgeSchema);
    return out ? parseJudgeVerdict(out) : null;
  }
}

/** Re-asks behind a failing verdict (Hindsight's default): three answers in all, majority wins. */
export const JUDGE_CONFIRMATIONS = 2;

export interface JudgedDraft {
  /**
   * The verdict that stands. `ok: false` only when most answers failed the rule; its problems are
   * the first failing answer's, plus any trap a majority named.
   */
  verdict: JudgeVerdict;
  /** "2/3 failed", for the PR body. */
  tally: string;
  /** A majority named contradicts-thread: the rule says the opposite of its own evidence. */
  contradicts: boolean;
  calls: number;
}

/**
 * One judged draft: a pass costs one call; a failure is re-asked `confirmations` times and kept
 * only when most answers fail it. Null when the first call gave no usable answer, so the caller
 * cannot vouch for the draft. Answers missing from a re-ask (no answer, an error) do not count.
 */
export async function judgeDraft(
  judge: DraftJudge,
  input: JudgeInput,
  confirmations = JUDGE_CONFIRMATIONS,
): Promise<JudgedDraft | null> {
  const primary = await judge.judge(input);
  if (!primary) return null;
  if (primary.ok || confirmations <= 0) {
    return {
      verdict: primary,
      tally: primary.ok ? "passed" : "1/1 failed",
      contradicts: !primary.ok && primary.problems.some((p) => p.trap === "contradicts-thread"),
      calls: 1,
    };
  }
  const again = await Promise.all(
    Array.from({ length: confirmations }, () => judge.judge(input).catch(() => null)),
  );
  const answers = [primary, ...again.filter((v): v is JudgeVerdict => v !== null)];
  const failed = answers.filter((v) => !v.ok);
  const calls = 1 + confirmations;
  const tally = `${failed.length}/${answers.length} failed`;
  if (failed.length * 2 <= answers.length) {
    return { verdict: { ok: true, problems: [] }, tally, contradicts: false, calls };
  }
  const named = (trap: JudgeTrap) =>
    failed.filter((v) => v.problems.some((p) => p.trap === trap)).length * 2 > answers.length;
  const problems = [...primary.problems];
  for (const trap of JUDGE_TRAPS) {
    if (!named(trap) || problems.some((p) => p.trap === trap)) continue;
    const from = failed.flatMap((v) => v.problems).find((p) => p.trap === trap);
    if (from) problems.push(from);
  }
  return {
    verdict: { ok: false, problems },
    tally,
    contradicts: named("contradicts-thread"),
    calls,
  };
}

/** The problems as one line, for the decision's reason. */
export const describeProblems = (problems: readonly JudgeProblem[]) =>
  problems.map((p) => `${p.trap}: ${p.evidence}`).join("; ");
