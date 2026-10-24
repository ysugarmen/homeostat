import { z } from "zod";
import type { Asker } from "./claude.ts";
import { commentKeyOf } from "./curator/urls.ts";
import { citedDocument, type DocSection, isDocPath, type Provenance, parseDoc } from "./doc.ts";
import { applySectionPatch, PatchError } from "./doc-patch.ts";
import type { Entry } from "./entry.ts";
import { redactSecrets } from "./secrets.ts";
import type { KbFiles } from "./validate.ts";
import { validate } from "./validate.ts";

/**
 * Retractions: document sections that still state what a retired rule said.
 *
 * Adapted from vectorize-io/hindsight, MIT (`hindsight_api/engine/reflect/retractions.py` and
 * its retraction prompt). A retired rule simply stops being served, but a document written from
 * it keeps stating it, and nothing notices, because every other check looks at what is present.
 * So the run that retires a rule looks for the sections grounded on it and asks the model to
 * take out only what rested on it, through the same one-section patch path as every other
 * document edit. As in Hindsight, only explicit grounding links count (here the rule's id in the
 * text, or its review thread as the section's provenance), never a text match: a section that
 * merely talks about the same thing may well rest on evidence the run cannot see, and removing
 * something still true is worse than leaving something stale.
 */

export interface RetiredRule {
  id: string;
  title: string;
  rule: string;
  why: string;
  /** Its review threads (`source.url` and `alsoFrom`): a section citing one rests on the rule. */
  urls: string[];
  /** Why it was retired, for the prompt and the PR. */
  reason: string;
}

export const retiredRule = (entry: Entry, reason: string): RetiredRule => ({
  id: entry.frontmatter.id,
  title: entry.frontmatter.title,
  rule: entry.sections.rule ?? "",
  why: entry.sections.why ?? "",
  urls: [entry.frontmatter.source.url, ...(entry.frontmatter.alsoFrom ?? [])].filter(
    (u): u is string => Boolean(u),
  ),
  reason,
});

export interface Citation {
  path: string;
  section: DocSection;
  rule: RetiredRule;
  /** How the section cites it: by the rule's id in its text, or by its thread as provenance. */
  by: "id" | "url";
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` names rule `id`. A multi-word id (`use-colour-tokens`) counts anywhere as a whole
 * token; a one-word id only in a credit form (`(id)`, `` `id` ``, `[id]`), where it cannot be an
 * ordinary word.
 */
export function citesId(text: string, id: string): boolean {
  const token = escape(id);
  if (id.includes("-") && new RegExp(`(?<![\\w-])${token}(?![\\w-])`, "i").test(text)) return true;
  return new RegExp(`[(\`[]${token}[)\`\\]]`, "i").test(text);
}

const sameUrl = (a: string, b: string) => {
  const ka = commentKeyOf(a);
  return ka ? ka === commentKeyOf(b) : a === b;
};

/** Every document section that cites one of `retired`, by id or by provenance. */
export function findCitations(files: KbFiles, retired: readonly RetiredRule[]): Citation[] {
  const out: Citation[] = [];
  for (const path of Object.keys(files).filter(isDocPath).sort()) {
    const doc = parseDoc(files[path] ?? "").doc;
    if (!doc) continue;
    for (const section of doc.sections) {
      if (!section.id) continue;
      for (const rule of retired) {
        const url = section.provenance?.url;
        if (url && rule.urls.some((u) => sameUrl(u, url))) {
          out.push({ path, section, rule, by: "url" });
        } else if (citesId(`${section.heading}\n${section.body}`, rule.id)) {
          out.push({ path, section, rule, by: "id" });
        }
      }
    }
  }
  return out;
}

export interface RetractionInput {
  section: { path: string; id: string; heading: string; body: string };
  retired: RetiredRule;
  /** Rules in force that the section also cites: what it says from them survives. */
  supported: { id: string; title: string; rule: string }[];
}

export interface Retraction {
  /** False when nothing in the section rests on the retired rule. */
  change: boolean;
  /** The section's whole new text. */
  body: string;
  reason: string;
}

/** One section, one call; null when the model gave no usable answer. */
export interface Retractor {
  retract(input: RetractionInput): Promise<Retraction | null>;
}

export const retractionSchema = z.object({
  change: z
    .boolean()
    .describe("false when nothing in the section rests on the retired rule; a normal answer"),
  body: z
    .string()
    .describe(
      "with change: the section's whole text with only the retired rule's claims taken out",
    ),
  reason: z.string().describe("one sentence: which claim rested on the retired rule"),
});

export const RETRACT_SYSTEM = `You keep a software team's reference documents honest. A coding rule the team followed has been retired: it is no longer in force, for the reason given. One section of a document cites that rule, by its id or by the review thread it came from, and may still state what the rule said.

Return the section's text with everything that rests on the retired rule taken out, and nothing else changed.

- Remove only what the retired rule supports: a sentence or bullet that states it, or the part of a sentence that does. Remove the rule's id wherever the section cites it.
- When in doubt, keep it. The section was written from more evidence than you are shown; text that merely looks related, or that the still-supported rules listed below back, stays exactly as it is. Removing something still true is worse than leaving something stale.
- Do not add anything: no replacement facts, no note that something was removed. The section must read as though the retired claim was never there.
- Do not tidy: no rewording, reordering or reformatting of what survives.
- If nothing in the section rests on the retired rule, set change to false. That is a normal, expected answer.`;

export function retractPrompt(input: RetractionInput): string {
  const { section, retired, supported } = input;
  return `<retired-rule id="${retired.id}">
Title: ${retired.title}
Rule: ${retired.rule}
Why: ${retired.why}
Retired because: ${retired.reason}
</retired-rule>
${
  supported.length
    ? `
Rules still in force that this section also cites:
${supported.map((s) => `- ${s.id}: ${s.title}. ${s.rule}`).join("\n")}
`
    : ""
}
<section path="${section.path}" id="${section.id}" heading="${section.heading}">
${section.body}
</section>`;
}

export class ClaudeRetractor implements Retractor {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async retract(input: RetractionInput): Promise<Retraction | null> {
    const out = await this.ask(RETRACT_SYSTEM, retractPrompt(input), retractionSchema);
    if (!out) return null;
    return { change: out.change, body: out.body.trim(), reason: out.reason.trim() };
  }
}

/** A document the run patched: its new text and, per section, the retired rule it no longer states. */
export interface RetractedDoc {
  path: string;
  text: string;
  sections: { id: string; ruleId: string; reason: string }[];
}

export interface RetractResult {
  docs: RetractedDoc[];
  /** Citations left as they are, and why: for the PR body and the run's output. */
  notes: string[];
  calls: number;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const vocabulary = (s: string) =>
  new Set(s.toLowerCase().match(/[\p{L}\p{N}_$@./-]+/gu) ?? ([] as string[]));
/**
 * Distinct words in `after` that `before` never used. Dropping a clause can take a joining word
 * or two; more than a few means the model wrote something new, which a retraction must not.
 */
const newWords = (before: string, after: string) => {
  const old = vocabulary(before);
  return [...vocabulary(after)].filter((w) => !old.has(w)).length;
};

/**
 * Patches every section that cites a retired rule, one model call each, at most `calls` in all.
 * Pure apart from the retractor: takes the KB files (with any of this run's edits laid over them)
 * and returns the documents to propose. A patch is kept only when it applies cleanly, validates,
 * removes the citation, adds no words and leaves text behind; anything else becomes a note, so a
 * person sees the citation either way. Without a retractor every citation is a note.
 */
export async function retractCitations(input: {
  files: KbFiles;
  retired: readonly RetiredRule[];
  retractor?: Retractor | undefined;
  /** Rules in force, by id: a section's other citations, sent as still supported. */
  inForce: ReadonlyMap<string, Entry>;
  calls: number;
  today: string;
  /** Provenance source for the rewritten section: the daily run or the deep dive. */
  source: "curator" | "deep-dive";
}): Promise<RetractResult> {
  const result: RetractResult = { docs: [], notes: [], calls: 0 };
  const current = (p: string) =>
    result.docs.find((d) => d.path === p)?.text ?? input.files[p] ?? "";
  const citations = findCitations(input.files, input.retired);
  for (const c of citations) {
    const where = `${c.path}#${c.section.id}`;
    const note = (why: string) =>
      result.notes.push(`${where} cites the retired ${c.rule.id}; ${why}`);
    if (!input.retractor) {
      note("check whether it still holds");
      continue;
    }
    if (result.calls >= input.calls) {
      note("not checked: the cap on retraction calls was reached");
      continue;
    }
    // Read the section again: an earlier patch in this run may have changed its document.
    const section = parseDoc(current(c.path)).doc?.sections.find((s) => s.id === c.section.id);
    if (!section) continue;
    const supported = [...input.inForce.values()]
      .filter((e) => e.frontmatter.id !== c.rule.id && citesId(section.body, e.frontmatter.id))
      .map((e) => ({
        id: e.frontmatter.id,
        title: redactSecrets(e.frontmatter.title).text,
        rule: redactSecrets(e.sections.rule ?? "").text,
      }));
    const clean = (s: string) => redactSecrets(s).text;
    result.calls++;
    let answer: Retraction | null;
    try {
      answer = await input.retractor.retract({
        section: {
          path: c.path,
          id: section.id,
          heading: clean(section.heading),
          body: clean(section.body),
        },
        retired: {
          ...c.rule,
          title: clean(c.rule.title),
          rule: clean(c.rule.rule),
          why: clean(c.rule.why),
        },
        supported,
      });
    } catch (e) {
      note(`could not be checked: ${(e as Error).message}`);
      continue;
    }
    if (!answer) {
      note("the model gave no usable answer");
      continue;
    }
    if (!answer.change) {
      note("nothing in it rests on the rule, so it is left as it is");
      continue;
    }
    const problem = !answer.body
      ? "the rewrite would empty the section; its owner decides whether to remove it"
      : /\[REDACTED:/.test(answer.body)
        ? "the rewrite contains redacted text"
        : words(answer.body) > words(section.body) || newWords(section.body, answer.body) > 3
          ? "the rewrite added text; a retraction only takes away"
          : citesId(answer.body, c.rule.id)
            ? "the rewrite still cites it"
            : answer.body === section.body
              ? "the rewrite changed nothing"
              : undefined;
    if (problem) {
      note(problem);
      continue;
    }
    const url = section.provenance?.url;
    // The retired rule's thread is no longer evidence, and a document never is.
    const keepUrl =
      url && !c.rule.urls.some((u) => sameUrl(u, url)) && !citedDocument(url) ? url : undefined;
    const provenance: Provenance = {
      source: input.source,
      ...(keepUrl ? { url: keepUrl } : {}),
      updated: input.today,
      note: `retracted ${c.rule.id}`,
    };
    const before = current(c.path);
    let text: string;
    try {
      text = applySectionPatch(
        before,
        { op: "replace", id: section.id, body: answer.body, provenance },
        input.today,
      );
    } catch (e) {
      note(e instanceof PatchError ? e.message : String(e));
      continue;
    }
    const codes = (t: string) =>
      new Set(
        validate({ ...input.files, [c.path]: t })
          .issues.filter((i) => i.file === c.path && i.severity === "error")
          .map((i) => i.code),
      );
    const old = codes(before);
    const added = [...codes(text)].filter((code) => !old.has(code));
    if (added.length) {
      note(`the rewrite does not validate (${added.join(", ")})`);
      continue;
    }
    const doc = result.docs.find((d) => d.path === c.path);
    const entry = { id: section.id, ruleId: c.rule.id, reason: answer.reason };
    if (doc) {
      doc.text = text;
      doc.sections.push(entry);
    } else result.docs.push({ path: c.path, text, sections: [entry] });
  }
  return result;
}
