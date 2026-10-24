import type { Entry } from "./entry.ts";
import type { Severity } from "./issues.ts";
import type { Frontmatter } from "./schema.ts";

export type ConflictKind =
  | "duplicate-id"
  | "missing-reference"
  | "one-sided-conflict"
  | "supersedes-cycle"
  | "superseded-not-retired"
  | "possible-duplicate";

export interface Conflict {
  kind: ConflictKind;
  severity: Severity;
  /** Entry ids involved; the first is the entry the finding should be reported on. */
  ids: string[];
  message: string;
}

/** Jaccard similarity of title word sets at or above which two titles count as the same rule. */
export const TITLE_SIMILARITY = 0.8;

/**
 * Deterministic cross-entry checks: broken references, cycles, and likely duplicates. It does
 * not judge whether two rules contradict each other in meaning; that is the deep-dive agent's job.
 */
export function detectConflicts(entries: readonly Frontmatter[]): Conflict[] {
  const found: Conflict[] = [];
  const byId = new Map<string, Frontmatter>();
  const reported = new Set<string>();

  for (const e of entries) {
    if (byId.has(e.id) && !reported.has(e.id)) {
      reported.add(e.id);
      found.push({
        kind: "duplicate-id",
        severity: "error",
        ids: [e.id],
        message: `id "${e.id}" is used by more than one entry`,
      });
    }
    byId.set(e.id, e);
  }

  for (const e of byId.values()) {
    for (const other of e.conflictsWith ?? []) {
      const target = byId.get(other);
      if (!target) {
        found.push(missing(e.id, "conflictsWith", other));
      } else if (!target.conflictsWith?.includes(e.id)) {
        found.push({
          kind: "one-sided-conflict",
          severity: "error",
          ids: [e.id, other],
          message: `conflictsWith lists "${other}", but "${other}" does not list "${e.id}" back`,
        });
      }
    }

    if (e.supersedes !== undefined) {
      const old = byId.get(e.supersedes);
      if (!old) {
        found.push(missing(e.id, "supersedes", e.supersedes));
      } else if (e.status === "accepted" && old.status !== "retired") {
        found.push({
          kind: "superseded-not-retired",
          severity: "error",
          ids: [old.id, e.id],
          message: `"${old.id}" is superseded by accepted entry "${e.id}" and must be retired`,
        });
      }
    }
  }

  found.push(...supersedesCycles(byId));
  found.push(...possibleDuplicates([...byId.values()]));
  return found;
}

function missing(id: string, field: string, target: string): Conflict {
  return {
    kind: "missing-reference",
    severity: "error",
    ids: [id],
    message: `${field}: no entry with id "${target}"`,
  };
}

function supersedesCycles(byId: Map<string, Frontmatter>): Conflict[] {
  const cycles: Conflict[] = [];
  const done = new Set<string>();
  for (const start of byId.keys()) {
    const path: string[] = [];
    let id: string | undefined = start;
    while (id !== undefined && !done.has(id) && !path.includes(id)) {
      path.push(id);
      id = byId.get(id)?.supersedes;
    }
    if (id !== undefined && path.includes(id)) {
      const cycle = path.slice(path.indexOf(id)).sort();
      cycles.push({
        kind: "supersedes-cycle",
        severity: "error",
        ids: cycle,
        message: `supersedes forms a cycle: ${cycle.join(" -> ")}`,
      });
    }
    for (const p of path) done.add(p);
  }
  return cycles;
}

function possibleDuplicates(entries: readonly Frontmatter[]): Conflict[] {
  const accepted = entries.filter((e) => e.status === "accepted");
  const found: Conflict[] = [];
  for (const [i, a] of accepted.entries()) {
    for (const b of accepted.slice(i + 1)) {
      if (
        titleSimilarity(a.title, b.title) >= TITLE_SIMILARITY &&
        scopesOverlap(a.scope, b.scope)
      ) {
        found.push({
          kind: "possible-duplicate",
          severity: "warning",
          ids: [a.id, b.id],
          message: `"${a.id}" and "${b.id}" have near-identical titles and overlapping scope; merge or mark them as conflicting`,
        });
      }
    }
  }
  return found;
}

const words = (title: string) => new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);

export function titleSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : shared / union;
}

/** Path segments before the first glob character, e.g. `services/api/**` → `services/api`. */
function staticPrefix(glob: string): string[] {
  const segments = glob.split("/");
  const firstGlob = segments.findIndex((s) => /[*?[{]/.test(s));
  return firstGlob === -1 ? segments : segments.slice(0, firstGlob);
}

/**
 * Conservative overlap test: two globs may match the same file when one static prefix contains
 * the other. It can report overlap for globs that are in fact disjoint, never the reverse.
 */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((ga) =>
    b.some((gb) => {
      const pa = staticPrefix(ga);
      const pb = staticPrefix(gb);
      const n = Math.min(pa.length, pb.length);
      return pa.slice(0, n).every((s, i) => s === pb[i]);
    }),
  );
}

/** Functions, file paths and code spans a rule names: `withRetry()`, `services/http.ts`. */
export function codeReferences(text: string): Set<string> {
  const found = text.match(/[A-Za-z_$][\w$.]*\(\)|[\w.-]+(?:\/[\w.-]+)+\.\w{1,5}|`[^`\n]+`/g) ?? [];
  return new Set(found.map((s) => s.replace(/`/g, "").toLowerCase()));
}

// The guards below are adapted from vectorize-io/hindsight (entity_resolver.py), MIT.

/**
 * The standalone numbers and versions a text states, normalised: `v2` → 2, `101`, `3.10` (kept
 * apart from 3.1), `4.0` → 4. Digits inside a word (`utf8`, `s3`) are part of a name, not a number.
 */
export function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])v?(\d+(?:\.\d+)*)(?!\w|\.\d)/gi)) {
    const parts = (m[1] ?? "").split(".");
    parts[0] = parts[0]?.replace(/^0+(?=\d)/, "") ?? "";
    if (parts.length === 2 && /^0+$/.test(parts[1] ?? "")) parts.pop();
    found.add(parts.join("."));
  }
  return found;
}

/**
 * Code names a text uses, lowercased: calls, camelCase, snake_case and single-word code spans
 * (`withRetry()` → withretry, `DATABASE_URL` → database_url, `ledger-sync`). Hyphenated prose
 * (hand-rolled, request-id) counts only inside a code span.
 */
export function identifiersIn(text: string): Set<string> {
  const found = new Set<string>();
  const add = (s: string) => found.add(s.replace(/\(\)$/, "").toLowerCase());
  for (const m of text.matchAll(/`([A-Za-z_$][\w$.-]*)(?:\(\))?`/g)) if (m[1]) add(m[1]);
  const plain = text.replace(/`/g, " ");
  const code =
    /[A-Za-z_$][\w$]*(?=\()|\b[a-z][a-z0-9]*[A-Z][\w$]*|\b[A-Z][a-z0-9]+[A-Z][\w$]*|\b[A-Za-z][A-Za-z0-9]*_[\w]+/g;
  for (const m of plain.matchAll(code)) add(m[0]);
  return found;
}

/** The words of an identifier: `useFooBar` → use, foo, bar; `ledger-sync` → ledger, sync. */
const nameParts = (id: string, original: string) =>
  (
    original
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [id]
  ).filter(Boolean);

/** The same word, inflected: retry/retries, call/calls/called. Not foo/fooBar. */
const sameStem = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.startsWith(short)) return /^(s|es|d|ed|ing)$/.test(long.slice(short.length));
  let n = 0;
  while (n < short.length && short[n] === long[n]) n++;
  // retry/retries: all but the last letter shared, at most two letters longer.
  return n >= 3 && n >= short.length - 1 && long.length - short.length <= 2;
};

/**
 * Two code names that look alike but name different things: one is the other plus a suffix
 * (`useFoo` and `useFooBar`), or they differ in exactly one word (`ledger-sync` and `ledger-sink`).
 * Plurals and other inflections of one word (`withRetry`, `withRetries`) are the same name.
 */
function lookalikeNames(a: string, b: string): [string, string] | undefined {
  const originals = (text: string) => {
    const map = new Map<string, string>();
    for (const m of text.replace(/`/g, " ").matchAll(/[A-Za-z_$][\w$-]*/g)) {
      map.set(m[0].toLowerCase(), m[0]);
    }
    return map;
  };
  const ia = identifiersIn(a);
  const ib = identifiersIn(b);
  const oa = originals(a);
  const ob = originals(b);
  for (const x of ia) {
    if (ib.has(x)) continue;
    for (const y of ib) {
      if (ia.has(y)) continue;
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      if (long.startsWith(short) && !sameStem(short, long)) return [x, y];
      const px = nameParts(x, oa.get(x) ?? x);
      const py = nameParts(y, ob.get(y) ?? y);
      if (px.length < 2 || px.length !== py.length) continue;
      const differ = px.flatMap((p, i) => (sameStem(p, py[i] ?? "") ? [] : [i]));
      if (differ.length === 1) return [x, y];
    }
  }
  return undefined;
}

/**
 * Why two rules state different facts however alike their words are, or undefined. Each has a
 * number or version the other lacks (v1 and v2, port 101 and 102), or they name look-alike code
 * (`useFoo` and `useFooBar`). Such pairs are never treated as one rule: not as duplicates by the
 * daily run or the deep dive, and not as candidates to merge.
 */
export function distinctFacts(a: Entry, b: Entry): string | undefined {
  const text = (e: Entry) => `${e.frontmatter.title}\n${e.sections.rule ?? ""}`;
  const na = numbersIn(text(a));
  const nb = numbersIn(text(b));
  const onlyA = [...na].filter((n) => !nb.has(n));
  const onlyB = [...nb].filter((n) => !na.has(n));
  if (onlyA.length && onlyB.length) return `different numbers (${onlyA[0]} and ${onlyB[0]})`;
  const names = lookalikeNames(text(a), text(b));
  if (names) return `different names (${names[0]} and ${names[1]})`;
  return undefined;
}

/**
 * Whether two rules teach the same lesson, for the daily run: near-identical titles, similar titles
 * with the same reason, or the same code named in both (two people rarely word a lesson alike, but
 * they name the same function).
 * Scopes must overlap either way.
 */
export function sameLesson(a: Entry, b: Entry): boolean {
  if (!scopesOverlap(a.frontmatter.scope, b.frontmatter.scope)) return false;
  if (distinctFacts(a, b)) return false;
  const titles = titleSimilarity(a.frontmatter.title, b.frontmatter.title);
  if (titles >= TITLE_SIMILARITY) return true;
  // A mostly similar title for the same reason, though each names its own example.
  if (titles >= 0.6 && titleSimilarity(a.sections.why ?? "", b.sections.why ?? "") >= 0.6)
    return true;
  const ra = codeReferences(a.sections.rule ?? "");
  const rb = codeReferences(b.sections.rule ?? "");
  if (ra.size === 0 || rb.size === 0) return false;
  // File paths say where, not what: many rules are about src/money.ts. Compare the code itself.
  const code = (refs: Set<string>) => [...refs].filter((r) => r.includes("(") || !r.includes("/"));
  const ca = code(ra);
  const cb = new Set(code(rb));
  const shared = ca.filter((r) => cb.has(r)).length;
  if (shared === 0) return false;
  // Mostly the same code, or a mostly similar title about some of the same code.
  return shared / new Set([...ca, ...cb]).size > 0.5 || titles >= 0.6;
}
