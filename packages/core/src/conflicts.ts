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

/**
 * Whether two rules teach the same lesson, for the daily run: near-identical titles, similar titles
 * with the same reason, or the same code named in both (two people rarely word a lesson alike, but
 * they name the same function).
 * Scopes must overlap either way.
 */
export function sameLesson(a: Entry, b: Entry): boolean {
  if (!scopesOverlap(a.frontmatter.scope, b.frontmatter.scope)) return false;
  const titles = titleSimilarity(a.frontmatter.title, b.frontmatter.title);
  if (titles >= TITLE_SIMILARITY) return true;
  // A mostly similar title for the same reason, though each names its own example.
  if (titles >= 0.6 && titleSimilarity(a.sections.why ?? "", b.sections.why ?? "") >= 0.6)
    return true;
  const ra = codeReferences(a.sections.rule ?? "");
  const rb = codeReferences(b.sections.rule ?? "");
  if (ra.size === 0 || rb.size === 0) return false;
  const shared = [...ra].filter((r) => rb.has(r)).length;
  // Mostly the same code, or a mostly similar title about some of the same code.
  return shared / new Set([...ra, ...rb]).size >= 0.5 || (shared > 0 && titles >= 0.6);
}
