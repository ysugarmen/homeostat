import { minimatch } from "minimatch";
import type { Entry } from "./entry.ts";
import type { Status } from "./schema.ts";

const STOP = new Set(
  "a an and are as at be by do does for from how i if in is it its of on or should that the this to use using was we what when where which with without you your".split(
    " ",
  ),
);

/** Very light stemming, enough that "calls" finds "call" and "logging" finds "log". */
const stem = (w: string) =>
  w.length > 4 && w.endsWith("ing")
    ? w.slice(0, -3)
    : w.length > 3 && w.endsWith("es") && !w.endsWith("ses")
      ? w.slice(0, -1)
      : w.length > 3 && w.endsWith("s") && !w.endsWith("ss")
        ? w.slice(0, -1)
        : w;

/** Words of `text`, split on camelCase and punctuation, lowercased, stemmed, stop words removed. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

export interface SearchOptions {
  area?: string;
  /** Only entries whose scope covers this repo-relative path. */
  path?: string;
  /** Defaults to accepted only. */
  statuses?: readonly Status[];
  limit?: number;
}

export interface SearchHit {
  entry: Entry;
  score: number;
}

/** Field weights: a match in the title says more than one in the reason. */
const FIELDS: { get: (e: Entry) => string; weight: number }[] = [
  { get: (e) => e.frontmatter.title, weight: 3 },
  { get: (e) => (e.frontmatter.tags ?? []).join(" "), weight: 2.5 },
  { get: (e) => e.frontmatter.id, weight: 2 },
  { get: (e) => e.sections.rule ?? "", weight: 2 },
  { get: (e) => e.sections.why ?? "", weight: 1 },
];

/**
 * BM25-style keyword search over entries, run on the CPU: no model call, so agents can search
 * the KB as often as they like. Weighted by field, ranked by score.
 */
export function searchEntries(
  entries: readonly Entry[],
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const statuses = new Set(opts.statuses ?? ["accepted"]);
  const pool = entries.filter(
    (e) =>
      statuses.has(e.frontmatter.status) &&
      (!opts.area || e.frontmatter.area === opts.area) &&
      (!opts.path || e.frontmatter.scope.some((g) => minimatch(opts.path ?? "", g, { dot: true }))),
  );

  const docs = pool.map((entry) => ({
    entry,
    fields: FIELDS.map(({ get, weight }) => ({ words: tokenize(get(entry)), weight })),
  }));
  const length = (d: (typeof docs)[number]) => d.fields.reduce((n, f) => n + f.words.length, 0);
  const avg = docs.reduce((n, d) => n + length(d), 0) / Math.max(docs.length, 1);
  const df = new Map(
    terms.map((t) => [t, docs.filter((d) => d.fields.some((f) => f.words.includes(t))).length]),
  );

  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map((d) => {
      const norm = 1 - b + (b * length(d)) / Math.max(avg, 1);
      let score = 0;
      for (const t of terms) {
        const tf = d.fields.reduce(
          (n, f) => n + f.weight * f.words.filter((w) => w === t).length,
          0,
        );
        if (tf === 0) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * norm);
      }
      return { entry: d.entry, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.frontmatter.score - a.entry.frontmatter.score)
    .slice(0, opts.limit ?? 5);
}
