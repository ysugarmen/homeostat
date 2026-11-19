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
  /** Literal code fragments the rule is about, so it follows that code into any file. */
  triggers?: string[];
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
  triggers: z
    .array(z.string())
    .optional()
    .describe(
      "0 to 4 short literal code fragments, copied from the thread's code, that appear in code this rule is about (e.g. `Literal[`, `freeze_time(`, `# TODO`); empty when the rule is about a place, a process or the pull request itself",
    ),
});

export const DRAFT_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow.

You get one code-review thread: a reviewer's comment on a pull request, any replies, and the fact that the author changed the code afterwards. Decide whether it holds a lasting rule that would help on other pull requests too, and if so write it.

Write the rule so it generalises beyond this pull request but stays concrete: name the function, package, path or pattern involved. Use only names, values and examples that appear in the thread; do not add illustrative values of your own, because other agents will treat every detail in the rule as fact. Take the reason only from the thread; never invent facts or motivations it does not state. If the reviewer gives no reason, write the most direct reason the thread supports, briefly.

When the rule is about how a kind of code is written (a type, a call, a library, a pattern), give triggers: short literal fragments that code breaking or following the rule contains, taken from the thread, so the rule reaches whoever writes such code next, in any file. Make them specific: never a bare keyword like def, class, import or return. Leave triggers empty when the rule is about a place, a deploy or a pull-request habit.

Set keep to false for one-offs: typos, naming nits specific to this code, questions, praise, or anything that only makes sense for this diff.`;

/**
 * The system prompt for one run's drafts: the instructions plus the areas and topics, which are
 * the same for every thread. Claude Code caches the system prompt across calls, so this part
 * is paid once; in the user turn, after the thread, it was paid in full on every call.
 */
export function draftSystem(ctx: DraftContext): string {
  const areas = [
    "core: applies everywhere",
    ...Object.entries(ctx.areas).map(([name, globs]) => `${name}: ${globs.join(", ")}`),
  ];
  return `${DRAFT_SYSTEM}

Areas and the paths they cover:
${areas.map((a) => `- ${a}`).join("\n")}${
  ctx.topics
    ? `

Topics (put the rule in the one it belongs to; if none fits, use general and suggest a new topic name):
${[...Object.entries(ctx.topics), ["general", "anything that fits no other topic"]].map(([name, about]) => `- ${name}: ${about}`).join("\n")}`
    : ""
}`;
}

/** The user turn for one thread: the PR, the file and line, and the conversation. */
export function draftPrompt(thread: ReviewThread, ctx: DraftContext): string {
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
</thread>${
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
    const out = await this.ask(draftSystem(ctx), draftPrompt(thread, ctx), draftSchema);
    if (!out?.keep) return null;
    return {
      title: out.title.trim(),
      rule: out.rule.trim(),
      why: out.why.trim(),
      area: out.area.trim(),
      ...(out.topic?.trim() ? { topic: out.topic.trim() } : {}),
      ...(out.suggested_topic?.trim() ? { suggestedTopic: out.suggested_topic.trim() } : {}),
      ...(out.triggers?.length ? { triggers: out.triggers } : {}),
    };
  }
}
