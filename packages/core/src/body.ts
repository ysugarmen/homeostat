import { error, type Issue } from "./issues.ts";

export const RULE_MAX_WORDS = 60;
export const WHY_MAX_WORDS = 100;

export interface BodySections {
  rule?: string;
  why?: string;
  example?: string;
}

const SECTIONS = { rule: "Rule", why: "Why", example: "Example" } as const;
type SectionKey = keyof typeof SECTIONS;

const isSectionKey = (name: string): name is SectionKey => Object.hasOwn(SECTIONS, name);
const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Splits an entry body into its fixed `## Rule`, `## Why` and `## Example` sections and checks
 * the structural rules. Headings inside fenced code blocks are content, not sections.
 */
export function parseBody(body: string): { sections: BodySections; issues: Issue[] } {
  const issues: Issue[] = [];
  const raw: Partial<Record<SectionKey, string[]>> = {};
  const preamble: string[] = [];
  let current: string[] | undefined;
  let fence: string | undefined;

  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (line.trim().startsWith(fence)) fence = undefined;
    }
    const heading = fence || fenceMatch ? undefined : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading?.[1]) {
      (current ?? preamble).push(line);
      continue;
    }
    const name = heading[1].toLowerCase();
    if (!isSectionKey(name)) {
      issues.push(
        error(
          "body.section.unknown",
          `unknown section "## ${heading[1]}"; allowed: Rule, Why, Example`,
        ),
      );
      current = [];
    } else if (raw[name]) {
      issues.push(error("body.section.duplicate", `section "## ${SECTIONS[name]}" appears twice`));
      current = [];
    } else {
      current = raw[name] = [];
    }
  }

  if (preamble.join("").trim()) {
    issues.unshift(
      error("body.preamble", "text before the first section; start the body with ## Rule"),
    );
  }

  const sections: BodySections = {};
  for (const key of Object.keys(SECTIONS) as SectionKey[]) {
    const text = raw[key]?.join("\n").trim();
    if (text) sections[key] = text;
  }

  if (!sections.rule) {
    issues.push(error("body.rule.missing", "missing or empty ## Rule section"));
  } else {
    if (/\n\s*\n/.test(sections.rule)) {
      issues.push(error("body.rule.multiParagraph", "## Rule must be a single paragraph"));
    }
    const n = countWords(sections.rule);
    if (n > RULE_MAX_WORDS) {
      issues.push(error("body.rule.tooLong", `## Rule has ${n} words; max ${RULE_MAX_WORDS}`));
    }
  }

  if (!sections.why) {
    issues.push(error("body.why.missing", "missing or empty ## Why section"));
  } else {
    const n = countWords(sections.why);
    if (n > WHY_MAX_WORDS) {
      issues.push(error("body.why.tooLong", `## Why has ${n} words; max ${WHY_MAX_WORDS}`));
    }
  }

  return { sections, issues };
}
