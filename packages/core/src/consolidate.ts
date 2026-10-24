import { z } from "zod";
import { parseBody } from "./body.ts";
import type { Asker } from "./claude.ts";
import type { Config } from "./config.ts";
import {
  codeReferences,
  distinctFacts,
  identifiersIn,
  sameLesson,
  scopesOverlap,
  titleSimilarity,
} from "./conflicts.ts";
import type { RuleText } from "./deepdive.ts";
import { type Entry, formatEntry } from "./entry.ts";
import type { Frontmatter } from "./schema.ts";
import { score } from "./score.ts";
import { redactSecrets } from "./secrets.ts";
import { countTokens } from "./tokens.ts";

/**
 * Consolidation: before the daily run adds a new lesson, it checks whether the lesson only
 * refines a rule already in force (update that rule) or repeats it (reconfirm it), so the same
 * lesson in other words does not land as a sibling rule. Candidates are found without a model;
 * one model call per lesson that has any decides.
 *
 * The decision rules and prompt are adapted from vectorize-io/hindsight (consolidation), MIT.
 */

/** A rule the lesson is compared with: in force, or waiting in an open review PR. */
export interface PoolRule {
  path: string;
  entry: Entry;
  /** Waiting in an open review PR, not yet in force. */
  waiting?: boolean;
}

export interface RuleCandidate extends PoolRule {
  /** 0–1: how much the two rules' words and code overlap. */
  similarity: number;
}

/** Overlap at or above which a rule is worth asking the model about. */
export const CANDIDATE_SIMILARITY = 0.25;
/** At most this many rules are shown to the model per lesson, closest first. */
export const MAX_CANDIDATES = 3;

const STOP = new Set(
  "a an and any are as at be before but by can do does for from has have if in into is it its never no not of on only or so than that the their them then there these this those to use used using via was were when where which while who will with without you your".split(
    " ",
  ),
);

/** Content words, lightly stemmed: `URLs` and `url` are one word. */
const contentWords = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
  );

const jaccard = (a: Set<string>, b: Set<string>) => {
  const shared = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
};

const codeOf = (e: Entry) =>
  new Set([
    ...identifiersIn(`${e.frontmatter.title}\n${e.sections.rule ?? ""}`),
    ...[...codeReferences(e.sections.rule ?? "")].map((r) => r.replace(/\(\)$/, "")),
  ]);

/**
 * The rules a new lesson may refine or repeat, closest first: same scope, overlapping words or
 * code, and none of the guards in `distinctFacts` (different numbers, look-alike names). Shared
 * code counts less the more rules name it, by 1/sqrt(rules naming it): a helper every rule
 * mentions says little about which rule this is. No model is involved.
 */
export function mergeCandidates(
  lesson: Entry,
  pool: readonly PoolRule[],
  opts: { min?: number; limit?: number } = {},
): RuleCandidate[] {
  const min = opts.min ?? CANDIDATE_SIMILARITY;
  const limit = opts.limit ?? MAX_CANDIDATES;
  const seen = new Map<string, number>();
  const codes = new Map<PoolRule, Set<string>>();
  for (const p of pool) {
    const c = codeOf(p.entry);
    codes.set(p, c);
    for (const r of c) seen.set(r, (seen.get(r) ?? 0) + 1);
  }
  // Adapted from vectorize-io/hindsight (entity_resolver.py, _cooccurrence_weight), MIT.
  const weight = (r: string) => 1 / Math.sqrt(Math.max(1, seen.get(r) ?? 1));
  const mine = codeOf(lesson);
  const words = contentWords(`${lesson.frontmatter.title} ${lesson.sections.rule ?? ""}`);
  const found: RuleCandidate[] = [];
  for (const p of pool) {
    const fm = p.entry.frontmatter;
    if (fm.id === lesson.frontmatter.id) continue;
    if (!scopesOverlap(fm.scope, lesson.frontmatter.scope)) continue;
    if (distinctFacts(lesson, p.entry)) continue;
    const theirs = codes.get(p) ?? new Set<string>();
    const union = new Set([...mine, ...theirs]);
    const sharedCode = [...mine].filter((r) => theirs.has(r));
    const total = [...union].reduce((n, r) => n + weight(r), 0);
    const code = total === 0 ? 0 : sharedCode.reduce((n, r) => n + weight(r), 0) / total;
    const text = jaccard(words, contentWords(`${fm.title} ${p.entry.sections.rule ?? ""}`));
    const titles = titleSimilarity(lesson.frontmatter.title, fm.title);
    const similarity = Math.max(titles, text, (text + code) / 2);
    if (similarity >= min || sameLesson(lesson, p.entry)) found.push({ ...p, similarity });
  }
  return found.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/** What to do with a new lesson, given the rules it may refine or repeat. */
export type Verdict =
  | { action: "create"; reason: string; contradicts?: string }
  | { action: "update"; id: string; reason: string; rule: RuleText }
  | { action: "duplicate"; id: string; reason: string };

/** Decides one lesson against its candidates; null when it cannot (the run falls back). */
export interface Consolidator {
  decide(lesson: Entry, candidates: readonly RuleCandidate[]): Promise<Verdict | null>;
}

// Adapted from vectorize-io/hindsight (consolidation/prompts.py and consolidator.py), MIT.
export const CONSOLIDATE_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow. A new lesson is about to be added. You get the lesson and the few existing rules most like it. Decide one of:

- update: the lesson is about the same specific thing as one existing rule (the same function, setting, file, command or practice) and adds a facet, a detail, a reason or a correction to it. Rewrite that rule so it says everything it said that is still true, plus what the lesson adds. One rule with several sources is better than several near-identical rules.
- duplicate: the lesson says nothing the existing rule does not already say, wording aside. The rule is reconfirmed and the lesson dropped.
- create: no existing rule is about the same specific thing. This is the right answer whenever nothing matches; you are preventing duplicates, not refusing new knowledge.

Rules:
1. Match on the specific thing and the facet, not the topic. Two rules about database URLs are not the same rule if one is about parsing and the other about logging. Never merge different facets into one rule.
2. Answer create when a number, version, negation, named entity or condition differs between the lesson and the rule (v1 and v2, port 101 and 102, "always" and "never", "in tests" and "in production"). Names a letter or a word apart (useFoo and useFooBar, ledger-sync and ledger-sink) are different things.
3. Never compute or derive new values; state only what the lesson or the rule states.
4. An update replaces the whole rule: its title, rule and why must still say everything the existing rule said, except what the lesson corrects. Keep its names, paths and examples. Add nothing neither text states. Title: an imperative sentence of at most 80 characters. Rule: one paragraph of at most 60 words. Why: at most 100 words.
5. Time: a rule marked newer="true" was confirmed after the lesson was written. Its current statement stands; the lesson may only add to it, not overwrite it.
6. If the lesson contradicts a rule (says the opposite), do not fold it in: answer create and put that rule's id in contradicts.
7. reason is required: one sentence. For create, name the rule you considered closest and why it does not match. For update or duplicate, say what is the same and, for an update, what the lesson adds.

rule_id: the id of the rule you update or duplicate, copied exactly; empty for create. title, rule, why: the rewritten rule for update; empty otherwise.`;

const block = (tag: string, attrs: string, e: Entry) =>
  `<${tag}${attrs}>\ntitle: ${e.frontmatter.title}\nscope: ${e.frontmatter.scope.join(", ")}\nrule: ${e.sections.rule ?? ""}\nwhy: ${e.sections.why ?? ""}\n</${tag}>`;

/** The user turn: the lesson and its candidates, secrets redacted. */
export function consolidatePrompt(lesson: Entry, candidates: readonly RuleCandidate[]): string {
  const written = lesson.frontmatter.created;
  const text = [
    block("lesson", ` written="${written}"`, lesson),
    "",
    "Existing rules:",
    ...candidates.map((c) =>
      block(
        "rule",
        ` id="${c.entry.frontmatter.id}" newer="${c.entry.frontmatter.lastConfirmed > written}"${c.waiting ? ` waiting_in_review="true"` : ""}`,
        c.entry,
      ),
    ),
  ].join("\n");
  return redactSecrets(text).text;
}

export const verdictSchema = z.object({
  reason: z.string().describe("one sentence: what you compared and why"),
  action: z.enum(["create", "update", "duplicate"]),
  rule_id: z.string().describe("for update or duplicate: the existing rule's id; else empty"),
  contradicts: z.string().describe("the id of a rule the lesson contradicts; else empty"),
  title: z.string().describe("update only: the rewritten title"),
  rule: z.string().describe("update only: the rewritten rule, at most 60 words"),
  why: z.string().describe("update only: the rewritten why, at most 100 words"),
});

const normal = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The model's answer as a verdict, or null when it is unusable: an id that is not one of the
 * candidates, or an update that breaks the rule limits. An update or create whose text is
 * exactly a candidate's is a duplicate of it.
 */
export function parseVerdict(
  out: z.infer<typeof verdictSchema> | null,
  lesson: Entry,
  candidates: readonly RuleCandidate[],
): Verdict | null {
  if (!out) return null;
  const reason = out.reason.trim() || "no reason given";
  const target = candidates.find((c) => c.entry.frontmatter.id === out.rule_id.trim());
  const sameText = (rule: string) =>
    candidates.find((c) => normal(c.entry.sections.rule ?? "") === normal(rule));
  if (out.action === "create") {
    const twin = sameText(lesson.sections.rule ?? "");
    if (twin) return { action: "duplicate", id: twin.entry.frontmatter.id, reason };
    const contradicts = candidates.find((c) => c.entry.frontmatter.id === out.contradicts.trim())
      ?.entry.frontmatter.id;
    return { action: "create", reason, ...(contradicts ? { contradicts } : {}) };
  }
  if (!target) return null;
  const id = target.entry.frontmatter.id;
  if (out.action === "duplicate") return { action: "duplicate", id, reason };
  const rule = { title: out.title.trim(), rule: out.rule.trim(), why: out.why.trim() };
  if (!rule.title || rule.title.length > 80) return null;
  if (parseBody(`## Rule\n${rule.rule}\n\n## Why\n${rule.why}`).issues.length) return null;
  if (normal(rule.rule) === normal(target.entry.sections.rule ?? "")) {
    return { action: "duplicate", id, reason };
  }
  return { action: "update", id, reason, rule };
}

export class ClaudeConsolidator implements Consolidator {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async decide(lesson: Entry, candidates: readonly RuleCandidate[]): Promise<Verdict | null> {
    if (!candidates.length) return { action: "create", reason: "no similar rule" };
    const out = await this.ask(
      CONSOLIDATE_SYSTEM,
      consolidatePrompt(lesson, candidates),
      verdictSchema,
    );
    return parseVerdict(out, lesson, candidates);
  }
}

/**
 * The rule `target` rewritten by an update: same id, area, scope, owner and first source; the
 * new title, rule and why; its example kept; confirmed today; and the lesson's URL added to
 * `alsoFrom`, so the review thread is known and not drafted again.
 */
export function applyUpdate(
  target: Entry,
  rule: RuleText,
  lesson: Entry,
  today: string,
  config: Config,
): string {
  const example = target.sections.example;
  const body = [
    `## Rule\n${rule.rule}`,
    `## Why\n${rule.why}`,
    ...(example ? [`## Example\n${example}`] : []),
  ].join("\n\n");
  const old = target.frontmatter;
  const url = lesson.frontmatter.source.url;
  const also = [...(old.alsoFrom ?? [])];
  if (url && url !== old.source.url && !also.includes(url)) also.push(url);
  const fm: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(old)) {
    if (k === "alsoFrom") continue;
    fm[k] = v;
    if (k === "source" && also.length) fm.alsoFrom = also;
  }
  Object.assign(fm, { title: rule.title, lastConfirmed: today, tokens: countTokens(body) });
  const out = fm as Frontmatter;
  out.score = score(out, { config }).score;
  return formatEntry(out, body);
}
