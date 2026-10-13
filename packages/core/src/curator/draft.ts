import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ReviewThread } from "./threads.ts";

export interface Draft {
  title: string;
  rule: string;
  why: string;
  area: string;
}

export interface DraftContext {
  /** Area name → path globs, from kbx.yaml. `core` is always available. */
  areas: Record<string, readonly string[]>;
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
});

export const DRAFT_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow.

You get one code-review thread: a reviewer's comment on a pull request, any replies, and the fact that the author changed the code afterwards. Decide whether it holds a lasting rule that would help on other pull requests too, and if so write it.

Write the rule so it generalises beyond this pull request but stays concrete: name the function, package, path or pattern involved. Take the reason only from the thread; never invent facts or motivations it does not state. If the reviewer gives no reason, write the most direct reason the thread supports, briefly.

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
${areas.map((a) => `- ${a}`).join("\n")}`;
}

/** The part of the Anthropic client the drafter uses, so tests can pass a stub. */
export type DraftClient = Pick<Anthropic, "beta">;

export interface ClaudeDrafterOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Defaults to a client reading ANTHROPIC_API_KEY (or the other standard credentials). */
  client?: DraftClient;
}

export class ClaudeDrafter implements Drafter {
  private readonly client: DraftClient;
  private readonly model: string;
  private readonly effort: ClaudeDrafterOptions["effort"];

  constructor(opts: ClaudeDrafterOptions) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model;
    this.effort = opts.effort;
  }

  async draft(thread: ReviewThread, ctx: DraftContext): Promise<Draft | null> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.effort, format: betaZodOutputFormat(draftSchema) },
      system: DRAFT_SYSTEM,
      messages: [{ role: "user", content: draftPrompt(thread, ctx) }],
    });
    if (response.stop_reason === "refusal") return null;
    const out = response.parsed_output;
    if (!out?.keep) return null;
    return {
      title: out.title.trim(),
      rule: out.rule.trim(),
      why: out.why.trim(),
      area: out.area.trim(),
    };
  }
}
