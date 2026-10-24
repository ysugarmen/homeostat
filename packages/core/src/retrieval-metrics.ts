/**
 * Ranked-retrieval metrics: pure functions of a ranked list of ids and the ids that should have
 * been found. Adapted from vectorize-io/hindsight, MIT
 * (hindsight-system-evals/hindsight_system_evals/retrieval_metrics.py), which follows
 * `pytrec_eval`, what BEIR scores with:
 *
 * - nDCG@k: `grade / log2(rank + 1)` with LINEAR gain, normalised by the ideal ordering.
 * - Recall@k, P@k: P divides by k, not by what came back, so returning little is not "precise".
 * - MRR@k: 1/rank of the first relevant id within k; `mrr` untruncated tells "found but ranked
 *   too low" from "never found".
 * - Hit@k: 1 when anything relevant is in the top k (BEIR's Accuracy@k).
 * - R-precision: P@R, R the query's number of relevant ids; cutoff-free, and exactly "was the
 *   right rule first" for a query with one gold rule.
 *
 * Relevance is graded (`id -> grade`, 0 = not relevant) so the functions match the original;
 * homeostat's eval cases are binary.
 */

/** The cutoffs reported. 1 and 3 are where ranking shows; 10 is about what a session gets. */
export const CUTOFFS = [1, 3, 5, 10] as const;

export type Relevance = Readonly<Record<string, number>>;

const rel = (relevant: Relevance, id: string) => relevant[id] ?? 0;
const total = (relevant: Relevance) => Object.values(relevant).filter((g) => g > 0).length;

/** Each id once, at its best rank. */
export function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Share of the relevant ids in the top k. */
export function recallAt(ranked: readonly string[], relevant: Relevance, k: number): number {
  const n = total(relevant);
  if (!n) return 0;
  return ranked.slice(0, k).filter((id) => rel(relevant, id) > 0).length / n;
}

/** Share of the top k that is relevant; divided by k, not by what came back. */
export function precisionAt(ranked: readonly string[], relevant: Relevance, k: number): number {
  if (k <= 0) return 0;
  return ranked.slice(0, k).filter((id) => rel(relevant, id) > 0).length / k;
}

/** nDCG@k with linear gain and a `log2(rank + 1)` discount. */
export function ndcgAt(ranked: readonly string[], relevant: Relevance, k: number): number {
  const gain = ranked.slice(0, k).reduce((s, id, i) => s + rel(relevant, id) / Math.log2(i + 2), 0);
  const ideal = Object.values(relevant)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return ideal ? gain / ideal : 0;
}

/** 1/rank of the first relevant id within k (untruncated without k); 0 when none. */
export function reciprocalRank(ranked: readonly string[], relevant: Relevance, k?: number): number {
  const list = k === undefined ? ranked : ranked.slice(0, k);
  const i = list.findIndex((id) => rel(relevant, id) > 0);
  return i < 0 ? 0 : 1 / (i + 1);
}

/** 1 when anything relevant is in the top k. */
export function hitAt(ranked: readonly string[], relevant: Relevance, k: number): number {
  return ranked.slice(0, k).some((id) => rel(relevant, id) > 0) ? 1 : 0;
}

/** P@R, R the number of relevant ids. */
export function rPrecision(ranked: readonly string[], relevant: Relevance): number {
  const n = total(relevant);
  return n ? precisionAt(ranked, relevant, n) : 0;
}

type PerCutoff = Record<(typeof CUTOFFS)[number], number>;
const perCutoff = (f: (k: number) => number) =>
  Object.fromEntries(CUTOFFS.map((k) => [k, f(k)])) as PerCutoff;

export interface QueryScore {
  id: string;
  /** Distinct ids the ranking reached, before any cutoff. */
  retrieved: number;
  goldTotal: number;
  /** Gold ids anywhere in the ranking: the ceiling every cutoff is bounded by. */
  goldFound: number;
  /** 1-based rank of the first gold id, or undefined when none came back. */
  firstHit: number | undefined;
  hit: PerCutoff;
  mrrAt: PerCutoff;
  ndcg: PerCutoff;
  recall: PerCutoff;
  precision: PerCutoff;
  mrr: number;
  rPrecision: number;
}

export function scoreQuery(
  id: string,
  ranking: readonly string[],
  relevant: Relevance,
): QueryScore {
  const ranked = dedupe(ranking);
  const rr = reciprocalRank(ranked, relevant);
  return {
    id,
    retrieved: ranked.length,
    goldTotal: total(relevant),
    goldFound: ranked.filter((x) => rel(relevant, x) > 0).length,
    firstHit: rr ? Math.round(1 / rr) : undefined,
    hit: perCutoff((k) => hitAt(ranked, relevant, k)),
    mrrAt: perCutoff((k) => reciprocalRank(ranked, relevant, k)),
    ndcg: perCutoff((k) => ndcgAt(ranked, relevant, k)),
    recall: perCutoff((k) => recallAt(ranked, relevant, k)),
    precision: perCutoff((k) => precisionAt(ranked, relevant, k)),
    mrr: rr,
    rPrecision: rPrecision(ranked, relevant),
  };
}

export interface RunScore {
  queries: number;
  hit: PerCutoff;
  mrrAt: PerCutoff;
  ndcg: PerCutoff;
  recall: PerCutoff;
  precision: PerCutoff;
  mrr: number;
  rPrecision: number;
  /** Queries that reached at least one gold id anywhere in their ranking. */
  reachedGold: number;
}

/** The macro-average: every query counts the same, as BEIR reports. */
export function aggregate(scores: readonly QueryScore[]): RunScore {
  const n = scores.length;
  const mean = (xs: number[]) => (n ? xs.reduce((a, b) => a + b, 0) / n : 0);
  const cut = (pick: (s: QueryScore) => PerCutoff) =>
    perCutoff((k) => mean(scores.map((s) => pick(s)[k as keyof PerCutoff])));
  return {
    queries: n,
    hit: cut((s) => s.hit),
    mrrAt: cut((s) => s.mrrAt),
    ndcg: cut((s) => s.ndcg),
    recall: cut((s) => s.recall),
    precision: cut((s) => s.precision),
    mrr: mean(scores.map((s) => s.mrr)),
    rPrecision: mean(scores.map((s) => s.rPrecision)),
    reachedGold: scores.filter((s) => s.goldFound > 0).length,
  };
}

/**
 * The sanity check before any number is trusted: more than half the queries must reach some gold
 * id. When they don't, the fixture is broken (wrong ids, wrong paths), not the ranking.
 */
export const mostReachGold = (run: Pick<RunScore, "queries" | "reachedGold">): boolean =>
  run.queries === 0 || run.reachedGold > Math.floor(run.queries / 2);
