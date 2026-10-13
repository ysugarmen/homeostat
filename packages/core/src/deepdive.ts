import { z } from "zod";
import { parseBody } from "./body.ts";
import type { Asker } from "./claude.ts";
import type { Config } from "./config.ts";
import { detectConflicts, scopesOverlap } from "./conflicts.ts";
import { type Entry, formatEntry } from "./entry.ts";
import type { Frontmatter } from "./schema.ts";
import { score } from "./score.ts";
import { countTokens } from "./tokens.ts";
import { type KbFiles, validate } from "./validate.ts";

export interface RuleText {
  title: string;
  rule: string;
  why: string;
}

/** Writes one rule covering two near-duplicate entries. */
export interface Merger {
  merge(keep: Entry, drop: Entry): Promise<RuleText>;
}

/** Of `candidates`, the ids of entries that contradict `entry`, with the reason. */
export interface ConflictJudge {
  conflicts(entry: Entry, candidates: Entry[]): Promise<{ id: string; reason: string }[]>;
}

export type DeepDiveAction = "merged" | "retired-duplicate" | "disputed" | "retired-stale";

export interface DeepDiveChange {
  path: string;
  text: string;
  id: string;
  actions: { action: DeepDiveAction; note: string }[];
}

export interface DeepDiveInput {
  files: KbFiles;
  /** ISO date; staleness and "this week" are measured from it. */
  today: string;
  /** Without one, survivors keep their own text. */
  merger?: Merger;
  /** Without one, no new conflicts are raised. */
  judge?: ConflictJudge;
}

export interface DeepDiveResult {
  changes: DeepDiveChange[];
  /** Things a human should look at that the agent did not change. */
  notes: string[];
}

export class DeepDiveError extends Error {}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;

interface Working {
  path: string;
  entry: Entry;
  fm: Frontmatter;
  /** New Rule/Why when merged; otherwise the body is kept as written. */
  text?: RuleText;
  actions: DeepDiveChange["actions"];
}

/**
 * The weekly deep dive, minus I/O: retires stale accepted entries, merges near-duplicate accepted
 * pairs into the higher-scoring one, and asks the judge whether this week's entries contradict
 * any accepted entry with an overlapping scope. Returns the rewritten files; a human merges them.
 */
export async function deepDive(input: DeepDiveInput): Promise<DeepDiveResult> {
  const kb = validate(input.files);
  const config = kb.config;
  if (!config)
    throw new DeepDiveError("homeostat.yaml is missing or invalid; run homeostat validate");
  const settings = config.agents.deepDive;

  const work = new Map<string, Working>(
    kb.entries.map(({ path, entry }) => [
      entry.frontmatter.id,
      { path, entry, fm: structuredClone(entry.frontmatter), actions: [] },
    ]),
  );
  const accepted = () => [...work.values()].filter((w) => w.fm.status === "accepted");
  const notes: string[] = [];

  for (const w of accepted()) {
    const age = Math.floor(daysBetween(w.fm.lastConfirmed, input.today));
    if (age > settings.staleAfterDays) {
      w.fm.status = "retired";
      w.actions.push({
        action: "retired-stale",
        note: `not confirmed for ${age} days (limit ${settings.staleAfterDays})`,
      });
    }
  }

  const pairs = detectConflicts(accepted().map((w) => w.fm)).filter(
    (c) => c.kind === "possible-duplicate",
  );
  for (const { ids } of pairs) {
    const [a, b] = ids.map((id) => work.get(id));
    if (!a || !b || a.fm.status !== "accepted" || b.fm.status !== "accepted") continue;
    const [keep, drop] = survivorFirst(a, b);
    if (keep.fm.supersedes !== undefined) {
      notes.push(
        `${keep.fm.id} and ${drop.fm.id} look like duplicates, but ${keep.fm.id} already supersedes ${keep.fm.supersedes}; merge them by hand`,
      );
      continue;
    }
    const own = {
      title: keep.fm.title,
      rule: keep.entry.sections.rule ?? "",
      why: keep.entry.sections.why ?? "",
    };
    keep.text = own;
    if (input.merger) {
      const merged = await input.merger.merge(keep.entry, drop.entry);
      const problems = [
        ...parseBody(`## Rule\n${merged.rule}\n\n## Why\n${merged.why}`).issues.map(
          (i) => i.message,
        ),
        ...(merged.title && merged.title.length <= 80 ? [] : ["title must be 1-80 characters"]),
      ];
      if (problems.length === 0) keep.text = merged;
      else
        notes.push(
          `merged text for ${keep.fm.id} was unusable (${problems.join("; ")}); kept its own text`,
        );
    }
    keep.fm.title = keep.text.title;
    keep.fm.scope = [...new Set([...keep.fm.scope, ...drop.fm.scope])];
    keep.fm.supersedes = drop.fm.id;
    keep.fm.lastConfirmed = input.today;
    drop.fm.status = "retired";
    keep.actions.push({ action: "merged", note: `absorbed ${drop.fm.id}` });
    drop.actions.push({ action: "retired-duplicate", note: `merged into ${keep.fm.id}` });
  }

  if (input.judge) {
    const asked = new Set<string>();
    const recent = accepted().filter(
      (w) =>
        daysBetween(w.fm.created, input.today) <= settings.lookbackHours / 24 ||
        daysBetween(w.fm.lastConfirmed, input.today) <= settings.lookbackHours / 24,
    );
    for (const w of recent) {
      if (w.fm.status !== "accepted") continue; // already disputed earlier in this run
      const candidates = accepted().filter((o) => {
        if (o === w || w.fm.conflictsWith?.includes(o.fm.id)) return false;
        const pair = [w.fm.id, o.fm.id].sort().join("|");
        return !asked.has(pair) && scopesOverlap(w.fm.scope, o.fm.scope);
      });
      for (const o of candidates) asked.add([w.fm.id, o.fm.id].sort().join("|"));
      if (candidates.length === 0) continue;
      const found = await input.judge.conflicts(
        w.entry,
        candidates.map((c) => c.entry),
      );
      for (const { id, reason } of found) {
        const other = work.get(id);
        if (!other || !candidates.includes(other)) continue;
        for (const [x, y] of [
          [w, other],
          [other, w],
        ] as const) {
          x.fm.conflictsWith = [...new Set([...(x.fm.conflictsWith ?? []), y.fm.id])];
          x.fm.status = "disputed";
          x.actions.push({ action: "disputed", note: `conflicts with ${y.fm.id}: ${reason}` });
        }
      }
    }
  }

  const changes = [...work.values()]
    .filter((w) => w.actions.length > 0)
    .map((w) => ({ path: w.path, id: w.fm.id, actions: w.actions, text: render(w, config) }));

  const after = { ...input.files, ...Object.fromEntries(changes.map((c) => [c.path, c.text])) };
  const errors = validate(after).issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new DeepDiveError(
      `deep dive produced an invalid KB: ${errors.map((e) => `${e.file}: ${e.message}`).join("; ")}`,
    );
  }
  return { changes, notes };
}

/** Higher score first; on a tie the older entry, then the smaller id. */
function survivorFirst(a: Working, b: Working): [Working, Working] {
  const order =
    b.fm.score - a.fm.score ||
    a.fm.created.localeCompare(b.fm.created) ||
    a.fm.id.localeCompare(b.fm.id);
  return order <= 0 ? [a, b] : [b, a];
}

function render(w: Working, config: Config): string {
  const body = w.text
    ? [
        `## Rule\n${w.text.rule}`,
        `## Why\n${w.text.why}`,
        ...(w.entry.sections.example ? [`## Example\n${w.entry.sections.example}`] : []),
      ].join("\n\n")
    : w.entry.body;
  const fm: Frontmatter = { ...w.fm, tokens: countTokens(body) };
  fm.score = score(fm, { config }).score;
  return formatEntry(fm, body);
}

export const MERGE_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow. Two accepted entries say nearly the same thing. Write one entry that replaces both: keep every concrete detail either one states (names, paths, packages, conditions), drop repetition, and invent nothing. Title: an imperative sentence of at most 80 characters. Rule: one paragraph of at most 60 words. Why: at most 100 words.`;

export const JUDGE_SYSTEM = `You maintain a software team's knowledge base of coding rules that AI coding agents follow. Given one entry and a list of other entries that apply to some of the same files, list only the entries that contradict it: following both would be impossible or would pull the code in opposite directions. Entries that overlap, repeat or refine each other are not contradictions. Give a one-sentence reason for each.`;

const asText = (e: Entry) =>
  `id: ${e.frontmatter.id}\ntitle: ${e.frontmatter.title}\nscope: ${e.frontmatter.scope.join(", ")}\nrule: ${e.sections.rule ?? ""}\nwhy: ${e.sections.why ?? ""}`;

export const mergePrompt = (keep: Entry, drop: Entry) =>
  `<entry>\n${asText(keep)}\n</entry>\n\n<entry>\n${asText(drop)}\n</entry>`;

export const judgePrompt = (entry: Entry, candidates: Entry[]) =>
  `<entry>\n${asText(entry)}\n</entry>\n\nOther entries:\n\n${candidates
    .map((c) => `<entry>\n${asText(c)}\n</entry>`)
    .join("\n\n")}`;

const mergeSchema = z.object({ title: z.string(), rule: z.string(), why: z.string() });
const judgeSchema = z.object({
  conflicts: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export class ClaudeMerger implements Merger {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async merge(keep: Entry, drop: Entry): Promise<RuleText> {
    const out = await this.ask(MERGE_SYSTEM, mergePrompt(keep, drop), mergeSchema);
    if (!out) {
      return {
        title: keep.frontmatter.title,
        rule: keep.sections.rule ?? "",
        why: keep.sections.why ?? "",
      };
    }
    return { title: out.title.trim(), rule: out.rule.trim(), why: out.why.trim() };
  }
}

export class ClaudeConflictJudge implements ConflictJudge {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async conflicts(entry: Entry, candidates: Entry[]) {
    const out = await this.ask(JUDGE_SYSTEM, judgePrompt(entry, candidates), judgeSchema);
    const known = new Set(candidates.map((c) => c.frontmatter.id));
    return (out?.conflicts ?? []).filter((c) => known.has(c.id));
  }
}
