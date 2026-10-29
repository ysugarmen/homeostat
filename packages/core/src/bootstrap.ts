import { minimatch } from "minimatch";
import { priceFor } from "./pricing.ts";
import { NEVER_READ, type RepoSnapshot, SEED_SYSTEM, type SeedTopic, seedPrompt } from "./seed.ts";
import { slugify } from "./slug.ts";
import { countTokens } from "./tokens.ts";

/**
 * `homeostat bootstrap`: a first base for each repo, built from a local checkout. The existing
 * documents are converted without a model; the code, data and infrastructure documents are
 * drafted by the seed topics.
 */

export const BOOTSTRAP_PARTS = ["docs", "code", "data", "infrastructure"] as const;
export type BootstrapPart = (typeof BOOTSTRAP_PARTS)[number];

/** The seed topics each model part drafts. */
export const PART_TOPICS: Record<Exclude<BootstrapPart, "docs">, SeedTopic[]> = {
  code: ["architecture", "conventions", "cross-repo"],
  data: ["data"],
  infrastructure: ["infrastructure"],
};

const DOC_FILE =
  /^(docs?\/.+\.md|CLAUDE\.md|AGENTS\.md|ARCHITECTURE\.md|CONTRIBUTING\.md|README\.md|.*\/(adr|adrs|decisions)\/[^/]+\.md|[^/]+\/README\.md|[^/]+\/[^/]+\/README\.md|[^/]+\/CLAUDE\.md|[^/]+\/[^/]+\/CLAUDE\.md)$/i;
const NOT_A_DOC =
  /(^|\/)(node_modules|vendor|dist|build|\.venv|venv|\.github|\.claude|templates?)\/|(^|\/)(CHANGELOG|CHANGES|LICENSE|CODE_OF_CONDUCT|SECURITY|PULL_REQUEST_TEMPLATE)[^/]*\.md$/i;
const MAX_DOCS = 40;

/** The markdown a repo already has that belongs in its base: docs/, agent notes, ADRs, READMEs. */
export function existingDocs(tracked: readonly string[], exclude: readonly string[]): string[] {
  const never = [...NEVER_READ, ...exclude];
  return tracked
    .filter((p) => DOC_FILE.test(p) && !NOT_A_DOC.test(p))
    .filter((p) => !never.some((g) => minimatch(p, g, { dot: true })))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, MAX_DOCS);
}

/**
 * The topic a converted document is stored under: its path without `docs/` and `.md`,
 * `services/api/README.md` as `services-api-readme`.
 */
export function docTopic(path: string): string {
  const stem = path.replace(/^docs?\//i, "").replace(/\.md$/i, "");
  return slugify(stem.replace(/\//g, "-")) ?? "document";
}

/** What a seed document's answer usually costs: a title, an intro and up to eight sections. */
export const SEED_OUTPUT_TOKENS = 2_500;

export interface Estimate {
  inputTokens: number;
  outputTokens: number;
  /** Dollars at API prices; undefined when the model's family is unknown. */
  dollars?: number;
}

/** Tokens a set of seed prompts will send and roughly receive, and their cost at API prices. */
export function estimate(
  prompts: readonly { snapshot: RepoSnapshot; topic: SeedTopic }[],
  model: string | undefined,
): Estimate {
  const system = countTokens(SEED_SYSTEM);
  const inputTokens = prompts.reduce(
    (n, p) => n + system + countTokens(seedPrompt(p.snapshot, p.topic)),
    0,
  );
  const outputTokens = prompts.length * SEED_OUTPUT_TOKENS;
  const price = priceFor(model);
  const dollars = price
    ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000
    : undefined;
  return { inputTokens, outputTokens, ...(dollars === undefined ? {} : { dollars }) };
}
