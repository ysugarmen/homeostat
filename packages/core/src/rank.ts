/**
 * Rank fusion for session selection. Adapted from vectorize-io/hindsight, MIT
 * (hindsight-api-slim/hindsight_api/engine/search/fusion.py).
 */

/** The usual reciprocal-rank-fusion constant: rank 1 scores 1/61, rank 10 scores 1/70. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: each id scores the sum over lists of `1 / (k + rank)`. An id missing
 * from a list gets nothing from it, so one that several arms agree on beats one that tops one arm.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly string[])[],
  k = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}
