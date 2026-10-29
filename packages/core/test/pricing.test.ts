import { expect, test } from "vitest";
import { estimateCostUsd, priceFor } from "../src/pricing.ts";

test("current models are priced from the one table, by id and then by family", () => {
  expect(priceFor("claude-opus-5-5")).toEqual({ input: 15, output: 75 });
  expect(priceFor("claude-sonnet-5-5")).toEqual({ input: 3, output: 15 });
  expect(priceFor("claude-haiku-4-5-20251001")).toEqual({ input: 1, output: 5 });
  // A region-prefixed Bedrock id finds its family.
  expect(priceFor("eu.anthropic.claude-sonnet-5-5-v1:0")).toEqual({ input: 3, output: 15 });
  expect(priceFor("some-other-model")).toBeUndefined();
});

test("a call's cost is estimated from its tokens; an unknown model costs as the dearest", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
  expect(estimateCostUsd("claude-sonnet-5-5", usage)).toBeCloseTo(3 + 1.5);
  expect(estimateCostUsd("claude-haiku-4-5-20251001", usage)).toBeCloseTo(1 + 0.5);
  expect(estimateCostUsd("some-other-model", usage)).toBeCloseTo(15 + 7.5);
  // Cache reads cost a tenth of input, writes a quarter more.
  expect(
    estimateCostUsd("claude-sonnet-5-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    }),
  ).toBeCloseTo(0.3 + 3.75);
});
