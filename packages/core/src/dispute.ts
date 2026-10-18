import { z } from "zod";
import { parseBody } from "./body.ts";
import type { Asker } from "./claude.ts";
import type { Config } from "./config.ts";
import type { RuleText } from "./deepdive.ts";
import { type Entry, formatEntry } from "./entry.ts";
import type { Frontmatter } from "./schema.ts";
import { score } from "./score.ts";
import { countTokens } from "./tokens.ts";

/** A corrected rule, with an example only when the old one still holds or was rewritten. */
export interface FixedRule extends RuleText {
  example?: string;
}

/** Rewrites a disputed rule so its flags no longer apply, or says it cannot be saved. */
export interface RuleFixer {
  fix(entry: Entry): Promise<FixedRule | null>;
}

/**
 * What a dispute PR proposes for a disputed rule: the fixed rule back in force, its flags
 * answered, or (with no fix) the rule retired. Merging the PR applies it.
 */
export function resolveDispute(
  entry: Entry,
  fixed: FixedRule | null,
  today: string,
  config: Config,
): string {
  if (!fixed) {
    return formatEntry({ ...entry.frontmatter, status: "retired" }, entry.body);
  }
  const body = [
    `## Rule\n${fixed.rule}`,
    `## Why\n${fixed.why}`,
    ...(fixed.example ? [`## Example\n${fixed.example}`] : []),
  ].join("\n\n");
  const { flags: _answered, ...rest } = entry.frontmatter;
  const fm: Frontmatter = {
    ...rest,
    title: fixed.title,
    status: "accepted",
    lastConfirmed: today,
    tokens: countTokens(body),
  };
  fm.score = score(fm, { config }).score;
  return formatEntry(fm, body);
}

/** Problems that make a fixer's text unusable; the dispute PR then proposes retiring the rule. */
export function fixProblems(fixed: FixedRule): string[] {
  const example = fixed.example ? `\n\n## Example\n${fixed.example}` : "";
  return [
    ...parseBody(`## Rule\n${fixed.rule}\n\n## Why\n${fixed.why}${example}`).issues.map(
      (i) => i.message,
    ),
    ...(fixed.title && fixed.title.length <= 80 ? [] : ["title must be 1-80 characters"]),
  ];
}

export const FIX_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow. Team members flagged this rule as wrong and said why. Rewrite it so the flags no longer apply: correct what they say is wrong (a renamed helper, a moved file, a changed convention) and keep every other part of the rule that they do not contradict. Invent nothing the rule or the flags do not say. If the flags say the rule as a whole no longer applies, set fixable to false. Title: an imperative sentence of at most 80 characters. Rule: one paragraph of at most 60 words. Why: at most 100 words. Example: the rule's example corrected the same way, or empty when it had none.`;

export const fixPrompt = (e: Entry) =>
  `<entry>\nid: ${e.frontmatter.id}\ntitle: ${e.frontmatter.title}\nscope: ${e.frontmatter.scope.join(", ")}\nrule: ${e.sections.rule ?? ""}\nwhy: ${e.sections.why ?? ""}\nexample: ${e.sections.example ?? ""}\n</entry>\n\nFlags:\n${(
    e.frontmatter.flags ?? []
  )
    .map((f) => `- ${f.by} (${f.date}): ${f.reason}`)
    .join("\n")}`;

const fixSchema = z.object({
  fixable: z.boolean(),
  title: z.string(),
  rule: z.string(),
  why: z.string(),
  example: z.string(),
});

export class ClaudeRuleFixer implements RuleFixer {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async fix(entry: Entry): Promise<FixedRule | null> {
    const out = await this.ask(FIX_SYSTEM, fixPrompt(entry), fixSchema);
    if (!out?.fixable) return null;
    return {
      title: out.title.trim(),
      rule: out.rule.trim(),
      why: out.why.trim(),
      ...(out.example.trim() ? { example: out.example.trim() } : {}),
    };
  }
}
