import { describe, expect, test } from "vitest";
import {
  aggregate,
  hitAt,
  mostReachGold,
  ndcgAt,
  precisionAt,
  recallAt,
  reciprocalRank,
  rPrecision,
  scoreQuery,
} from "../src/retrieval-metrics.ts";

// Hand-computed values. Ranking a x b y c against gold {a, b, d}.
const ranked = ["a", "x", "b", "y", "c"];
const gold = { a: 1, b: 1, d: 1 };

describe("retrieval metrics", () => {
  test("recall, precision, hit and reciprocal rank", () => {
    expect(recallAt(ranked, gold, 1)).toBeCloseTo(1 / 3);
    expect(recallAt(ranked, gold, 3)).toBeCloseTo(2 / 3);
    expect(recallAt(ranked, gold, 10)).toBeCloseTo(2 / 3);
    expect(precisionAt(ranked, gold, 1)).toBe(1);
    expect(precisionAt(ranked, gold, 3)).toBeCloseTo(2 / 3);
    // Divided by k, not by the five that came back.
    expect(precisionAt(ranked, gold, 10)).toBeCloseTo(0.2);
    expect(hitAt(ranked, gold, 1)).toBe(1);
    expect(hitAt(["x", "y", "b"], { b: 1 }, 1)).toBe(0);
    expect(hitAt(["x", "y", "b"], { b: 1 }, 3)).toBe(1);
    expect(reciprocalRank(["x", "y", "b"], { b: 1 })).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["x", "y", "b"], { b: 1 }, 1)).toBe(0);
    expect(reciprocalRank([], { b: 1 })).toBe(0);
  });

  test("nDCG uses linear gain and a log2(rank + 1) discount", () => {
    // gain 1/1 + 1/log2(4) = 1.5; ideal 1 + 1/log2(3) + 1/2 = 2.13093.
    expect(ndcgAt(ranked, gold, 3)).toBeCloseTo(1.5 / 2.13093, 5);
    expect(ndcgAt(["x", "y", "b"], { b: 1 }, 3)).toBeCloseTo(0.5, 6);
    // Graded: b (1) then a (2): (1 + 2/log2(3)) / (2 + 1/log2(3)).
    expect(ndcgAt(["b", "a"], { a: 2, b: 1 }, 3)).toBeCloseTo(2.26186 / 2.63093, 5);
    expect(ndcgAt(["x"], {}, 3)).toBe(0);
  });

  test("R-precision is precision at the number of gold ids", () => {
    expect(rPrecision(ranked, gold)).toBeCloseTo(2 / 3);
    expect(rPrecision(["b", "x"], { b: 1 })).toBe(1);
    expect(rPrecision(["x", "b"], { b: 1 })).toBe(0);
  });

  test("a query score dedupes and names the first hit; the run averages per query", () => {
    const one = scoreQuery("one", ["a", "a", "x", "b", "y", "c"], gold);
    expect(one).toMatchObject({ retrieved: 5, goldTotal: 3, goldFound: 2, firstHit: 1, mrr: 1 });
    const two = scoreQuery("two", ["x", "y", "b"], { b: 1 });
    expect(two.firstHit).toBe(3);
    expect(two.hit[1]).toBe(0);
    expect(two.hit[3]).toBe(1);
    const none = scoreQuery("none", ["x"], { b: 1 });
    expect(none.firstHit).toBeUndefined();

    const run = aggregate([one, two, none]);
    expect(run.queries).toBe(3);
    expect(run.mrr).toBeCloseTo((1 + 1 / 3 + 0) / 3);
    expect(run.hit[3]).toBeCloseTo(2 / 3);
    expect(run.recall[10]).toBeCloseTo((2 / 3 + 1 + 0) / 3);
    expect(run.reachedGold).toBe(2);
    expect(mostReachGold(run)).toBe(true);
    expect(mostReachGold(aggregate([none, none, one]))).toBe(false);
    expect(mostReachGold(aggregate([one, none]))).toBe(false);
  });
});
