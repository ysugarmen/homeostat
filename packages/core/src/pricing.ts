import type { Usage } from "./claude.ts";

/** Dollars per million tokens, in and out, at API prices. */
export interface Price {
  input: number;
  output: number;
}

/**
 * The one price table: what a call costs when the runtime reports tokens but no cost (the API,
 * Bedrock, Vertex), for the spending cap and the run report, and what a bootstrap would cost.
 * Exact model ids first, then by family, so a dated or region-prefixed id still finds its price.
 * Approximate: update it when prices change. Figures from it are labelled estimates.
 */
const MODEL_PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};
/** Older or unlisted models by family, at the family's dearest current price. */
const FAMILY_PRICES: [RegExp, Price][] = [
  [/haiku/i, { input: 1, output: 5 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/opus/i, { input: 5, output: 25 }],
  [/fable|mythos/i, { input: 10, output: 50 }],
];
/** What an unknown model is priced as: the dearest family, so a cap is never under-counted. */
const DEAREST: Price = { input: 10, output: 50 };
/** Cache reads and writes, as a share of the input price (reads are 0.05-0.1x; 0.1x errs high). */
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

/** The model's price, or undefined for a model the table does not know. */
export function priceFor(model: string | undefined): Price | undefined {
  if (!model) return undefined;
  const known = Object.entries(MODEL_PRICES).find(([id]) => model.includes(id))?.[1];
  return MODEL_PRICES[model] ?? known ?? FAMILY_PRICES.find(([re]) => re.test(model))?.[1];
}

/**
 * A call's cost in dollars, estimated from its tokens. A model the table does not know is priced
 * as the dearest family, so a cap is never under-counted.
 */
export function estimateCostUsd(
  model: string,
  usage: Pick<Usage, "inputTokens" | "outputTokens"> & Partial<Usage>,
): number {
  const p = priceFor(model) ?? DEAREST;
  const input =
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) * CACHE_READ +
    (usage.cacheWriteTokens ?? 0) * CACHE_WRITE;
  return (input * p.input + usage.outputTokens * p.output) / 1_000_000;
}

/**
 * Thrown by an asker instead of starting a call once the run has spent `agents.maxCostUsd`.
 * Callers stop asking and leave what is left for the next run.
 */
export class SpendingCapError extends Error {
  readonly spentUsd: number;
  readonly maxCostUsd: number;
  constructor(spentUsd: number, maxCostUsd: number) {
    super(`stopped at the spending cap: $${spentUsd.toFixed(2)} of $${maxCostUsd.toFixed(2)}`);
    this.spentUsd = spentUsd;
    this.maxCostUsd = maxCostUsd;
  }
}
