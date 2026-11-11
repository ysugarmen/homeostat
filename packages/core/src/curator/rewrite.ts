import { z } from "zod";
import type { Asker } from "../claude.ts";

/**
 * A reviewer's comment on a review PR, turned into the change it asks for. Reviewers asked in
 * comments for a rule to be generalised or rescoped ("scope it to all python code") and then had
 * to edit the topic file by hand; the daily run now applies such a comment, and replies.
 */
export interface RewriteInput {
  /** The reviewer's comment, and earlier ones on the PR for context. */
  comment: { author: string; body: string };
  earlier: readonly { author: string; body: string }[];
  rule: { title: string; rule: string; why: string; area: string; scope: readonly string[] };
  /** The areas the rule may move to: core (everywhere in the repo) and the repo's own. */
  areas: Readonly<Record<string, readonly string[]>>;
}

export interface Rewrite {
  /** False when the comment asks for no change (a question, an approval, a remark). */
  change: boolean;
  title: string;
  rule: string;
  why: string;
  area: string;
  scope: string[];
  /** One sentence for the PR: what changed, or why nothing did. */
  reply: string;
}

export interface ReviewRewriter {
  rewrite(input: RewriteInput): Promise<Rewrite | null>;
}

export const REWRITE_SYSTEM = `You maintain a team's coding rules. A reviewer commented on a proposed rule before accepting it. Decide whether the comment asks to change the rule, and if it does, rewrite the rule exactly as the reviewer asks.

The reviewer decides: if they ask to generalise the rule, scope it wider or narrower, reword it or move it to another area, do that, even past what the original review said. Keep everything they did not ask to change. Keep the team's plain, short style: one paragraph of rule (at most 60 words), one of why (at most 100), no headings or lists. Keep a concrete example from the original when it still helps.

Scope is a list of path globs in the code repo. "**" means every file; "**/*.py" every Python file. An area's globs come with it: to scope a rule to everywhere, use the area "core" and the scope ["**"], or a narrower glob such as ["**/*.py"]. Use only the areas listed.

When the comment asks for no change (a question, an approval, a remark), answer change: false and keep the rule as it is.`;

export const rewriteSchema = z.object({
  change: z.boolean().describe("true only when the comment asks to change the rule"),
  title: z.string().describe("the rule's title, at most 80 characters"),
  rule: z.string().describe("the rule"),
  why: z.string().describe("why the rule exists"),
  area: z.string().describe("one of the listed areas"),
  scope: z.array(z.string()).describe("path globs the rule applies to"),
  reply: z.string().describe("one sentence for the reviewer: what changed, or why nothing did"),
});

export function rewritePrompt(input: RewriteInput): string {
  const areas = Object.entries(input.areas)
    .map(([name, globs]) => `- ${name}: ${globs.join(", ")}`)
    .join("\n");
  const earlier = input.earlier.length
    ? `\nEarlier comments on the PR:\n${input.earlier.map((c) => `${c.author}: ${c.body.trim()}`).join("\n\n")}\n`
    : "";
  return `<rule>
Title: ${input.rule.title}
Area: ${input.rule.area}
Scope: ${input.rule.scope.join(", ")}
Rule: ${input.rule.rule}
Why: ${input.rule.why}
</rule>

Areas the rule may be in:
${areas}
${earlier}
<comment author="${input.comment.author}">
${input.comment.body.trim()}
</comment>`;
}

export class ClaudeReviewRewriter implements ReviewRewriter {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async rewrite(input: RewriteInput): Promise<Rewrite | null> {
    const parsed = rewriteSchema.safeParse(
      await this.ask(REWRITE_SYSTEM, rewritePrompt(input), rewriteSchema),
    );
    if (!parsed.success) return null;
    const r = parsed.data;
    return {
      ...r,
      title: r.title.trim().slice(0, 80),
      rule: r.rule.trim(),
      why: r.why.trim(),
      area: r.area.trim(),
      scope: r.scope.map((g) => g.trim()).filter(Boolean),
      reply: r.reply.trim(),
    };
  }
}
