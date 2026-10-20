import { z } from "zod";
import type { Asker } from "../claude.ts";
import type { ReviewThread } from "./threads.ts";

export interface Draft {
  title: string;
  rule: string;
  why: string;
  area: string;
  /** With topics configured: the topic it belongs in, or general. */
  topic?: string;
  /** When no topic fits: a short name for a new one, for a person to consider. */
  suggestedTopic?: string;
}

export interface DraftContext {
  /** Area name → path globs, from homeostat.yaml. `core` is always available. */
  areas: Record<string, readonly string[]>;
  /** Topic name → description, when the KB groups rules by topic. */
  topics?: Record<string, string>;
  /** A second try: the previous draft and the limits it broke. */
  revise?: { previous: Draft; problems: string[] };
}

/** Turns one review thread into at most one rule; null when the thread holds no lasting lesson. */
export interface Drafter {
  draft(thread: ReviewThread, ctx: DraftContext): Promise<Draft | null>;
}

export const draftSchema = z.object({
  keep: z
    .boolean()
    .describe(
      "false when the thread is a one-off (typo, naming nit, question) with no lasting rule",
    ),
  title: z.string().describe("imperative sentence, at most 80 characters"),
  rule: z.string().describe("one paragraph, at most 60 words: what to do from now on"),
  why: z.string().describe("at most 100 words: the reason, from the thread"),
  area: z.string().describe("one of the listed areas, or core"),
  topic: z
    .string()
    .optional()
    .describe("one of the listed topics, or general; only when topics are listed"),
  suggested_topic: z
    .string()
    .optional()
    .describe(
      "only with topic general: a short lowercase-hyphenated name for a new topic it would fit",
    ),
});

export const DRAFT_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow.

You get one code-review thread: a reviewer's comment on a pull request, any replies, and the fact that the author changed the code afterwards. Decide whether it holds a lasting rule that would help on other pull requests too, and if so write it.

Write the rule so it generalises beyond this pull request but stays concrete: name the function, package, path or pattern involved. Use only names, values and examples that appear in the thread; do not add illustrative values of your own, because other agents will treat every detail in the rule as fact. Take the reason only from the thread; never invent facts or motivations it does not state. If the reviewer gives no reason, write the most direct reason the thread supports, briefly.

Set keep to false for one-offs: typos, naming nits specific to this code, questions, praise, or anything that only makes sense for this diff.`;

/** The user turn for one thread: the PR, the file and line, and the conversation. */
export function draftPrompt(thread: ReviewThread, ctx: DraftContext): string {
  const areas = [
    "core: applies everywhere",
    ...Object.entries(ctx.areas).map(([name, globs]) => `${name}: ${globs.join(", ")}`),
  ];
  const location = thread.root.path
    ? `${thread.root.path}${thread.root.line ? `:${thread.root.line}` : ""}`
    : "the pull request as a whole";
  const conversation = [thread.root, ...thread.replies]
    .map((c) => `${c.author.id}: ${c.body.trim()}`)
    .join("\n\n");
  return `Repository: ${thread.repo}
Pull request: ${thread.pullRequest.title} (by ${thread.pullRequest.author.id})
Comment on: ${location}
The author changed the code after this feedback.

<thread>
${conversation}
</thread>

Areas and the paths they cover:
${areas.map((a) => `- ${a}`).join("\n")}${
  ctx.topics
    ? `

Topics (put the rule in the one it belongs to; if none fits, use general and suggest a new topic name):
${[...Object.entries(ctx.topics), ["general", "anything that fits no other topic"]].map(([name, about]) => `- ${name}: ${about}`).join("\n")}`
    : ""
}${
  ctx.revise
    ? `

Your previous draft broke these limits:
${ctx.revise.problems.map((p) => `- ${p}`).join("\n")}

Previous draft:
Title: ${ctx.revise.previous.title}
Rule: ${ctx.revise.previous.rule}
Why: ${ctx.revise.previous.why}

Write it again within the limits, keeping every name and fact it states.`
    : ""
}`;
}

/** Drafts with Claude through either runtime (API or Claude Code). */
export class ClaudeDrafter implements Drafter {
  private readonly ask: Asker;

  constructor(ask: Asker) {
    this.ask = ask;
  }

  async draft(thread: ReviewThread, ctx: DraftContext): Promise<Draft | null> {
    const out = await this.ask(DRAFT_SYSTEM, draftPrompt(thread, ctx), draftSchema);
    if (!out?.keep) return null;
    return {
      title: out.title.trim(),
      rule: out.rule.trim(),
      why: out.why.trim(),
      area: out.area.trim(),
      ...(out.topic?.trim() ? { topic: out.topic.trim() } : {}),
      ...(out.suggested_topic?.trim() ? { suggestedTopic: out.suggested_topic.trim() } : {}),
    };
  }
}
