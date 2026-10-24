import { parse } from "yaml";
import { z } from "zod";
import type { Entry } from "./entry.ts";
import { error, type Issue } from "./issues.ts";
import {
  aggregate,
  mostReachGold,
  type QueryScore,
  type RunScore,
  scoreQuery,
} from "./retrieval-metrics.ts";
import { isRejectedDecision } from "./schema.ts";
import { searchEntries } from "./search.ts";
import { selectEntries } from "./select.ts";

/** Where a team keeps its selection cases, relative to the KB root. */
export const EVAL_FILE = "eval/selection.yaml";

/** How many search hits a case is scored on: what the MCP `search` tool returns by default. */
export const EVAL_SEARCH_LIMIT = 10;

export const evalCaseSchema = z
  .strictObject({
    /** A short name for the report; defaults to the case's position. */
    name: z.string().min(1).optional(),
    /** Files the session touches: scored through session selection (the hook and MCP context). */
    paths: z.array(z.string().min(1)).optional(),
    /** What the agent would search for: scored through keyword search (MCP and CLI search). */
    task: z.string().min(1).optional(),
    /** The repo the session is in, for a multi-repo KB. */
    repo: z.string().min(1).optional(),
    /** Rule ids that should be served, best first is not required. */
    expect: z.array(z.string().min(1)).min(1, "must name at least one rule id"),
  })
  .refine((c) => c.paths !== undefined || c.task !== undefined, {
    message: "needs paths, task or both",
  });

export const evalFileSchema = z.strictObject({
  cases: z.array(evalCaseSchema).min(1, "must list at least one case"),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

/** Reads `eval/selection.yaml`: the cases, or the issues that make the file unusable. */
export function parseEvalCases(text: string): { cases: EvalCase[]; issues: Issue[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return {
      cases: [],
      issues: [error("eval.yaml", `not valid YAML: ${(e as Error).message.split("\n")[0]}`)],
    };
  }
  const parsed = evalFileSchema.safeParse(raw);
  if (parsed.success) return { cases: parsed.data.cases, issues: [] };
  return {
    cases: [],
    issues: parsed.error.issues.map((i) =>
      error("eval.schema", `${i.path.join(".") || "(file)"}: ${i.message}`, {
        path: i.path.join("."),
      }),
    ),
  };
}

export type Surface = "session" | "search";

export interface CaseResult {
  name: string;
  surface: Surface;
  repo?: string;
  expect: string[];
  /** Every rule the surface ranked, best first. For a session: those served, then the rest. */
  ranked: string[];
  /** For a session, the rules that fit the budget; for search, the hits returned. */
  served: string[];
  score: QueryScore;
}

export interface SurfaceReport extends RunScore {
  /** Share of gold rules actually served (within the budget, or in the returned hits). */
  served: number;
}

export interface EvalReport {
  cases: CaseResult[];
  /** Fixture problems: unknown ids or repos. Any of them makes the run fail. */
  problems: string[];
  session: SurfaceReport;
  search: SurfaceReport;
  all: SurfaceReport;
  /** More than half the cases reached some gold rule; otherwise the fixture is likely wrong. */
  sane: boolean;
}

export interface EvalPool {
  /** The rules a session in `repo` sees (shared ones plus that repo's). */
  entries: (repo: string | undefined) => readonly Entry[];
  /** The KB's repos, for a multi-repo KB. */
  repos?: readonly string[];
}

export interface EvalOptions {
  tokenBudget: number;
  maxChars?: number;
  searchLimit?: number;
  /** Ranking under test; defaults to the code sessions and search use. */
  select?: typeof selectEntries;
  search?: typeof searchEntries;
}

const servable = (e: Entry) =>
  e.frontmatter.status === "accepted" && !isRejectedDecision(e.frontmatter);

function surfaceReport(results: readonly CaseResult[]): SurfaceReport {
  const gold = results.reduce((n, r) => n + r.expect.length, 0);
  const served = results.reduce(
    (n, r) => n + r.expect.filter((id) => r.served.includes(id)).length,
    0,
  );
  return { ...aggregate(results.map((r) => r.score)), served: gold ? served / gold : 0 };
}

/**
 * Runs each case through the same selection code the session hook and MCP use: `paths` through
 * `selectEntries`, `task` through `searchEntries`. A case with both is scored twice, once per
 * surface. No model call: it runs in CI.
 */
export function runSelectionEval(
  cases: readonly EvalCase[],
  pool: EvalPool,
  opts: EvalOptions,
): EvalReport {
  const select = opts.select ?? selectEntries;
  const search = opts.search ?? searchEntries;
  const problems: string[] = [];
  const results: CaseResult[] = [];
  cases.forEach((c, i) => {
    const name = c.name ?? `case ${i + 1}`;
    if (c.repo && pool.repos && !pool.repos.includes(c.repo)) {
      problems.push(`${name}: unknown repo "${c.repo}" (repos: ${pool.repos.join(", ")})`);
      return;
    }
    if (c.repo && !pool.repos) {
      problems.push(`${name}: repo "${c.repo}" given, but this knowledge base has no repos`);
      return;
    }
    const entries = pool.entries(c.repo);
    const byId = new Map(entries.map((e) => [e.frontmatter.id, e]));
    const bad = c.expect.filter((id) => {
      const e = byId.get(id);
      if (!e) {
        problems.push(
          `${name}: no rule "${id}"${c.repo ? ` in repo ${c.repo} or the shared rules` : ""}`,
        );
        return true;
      }
      if (!servable(e)) {
        const what = isRejectedDecision(e.frontmatter)
          ? "a rejected decision"
          : e.frontmatter.status;
        problems.push(`${name}: rule "${id}" is ${what}, never served`);
        return true;
      }
      return false;
    });
    if (bad.length) return;
    const relevant = Object.fromEntries(c.expect.map((id) => [id, 1]));
    const base = { name, ...(c.repo ? { repo: c.repo } : {}), expect: c.expect };
    if (c.paths) {
      const sel = select(entries, {
        paths: c.paths,
        tokenBudget: opts.tokenBudget,
        ...(opts.maxChars ? { maxChars: opts.maxChars } : {}),
      });
      const served = sel.items.map((x) => x.entry.frontmatter.id);
      const ranked = [...served, ...sel.rest.map((e) => e.frontmatter.id)];
      results.push({
        ...base,
        surface: "session",
        ranked,
        served,
        score: scoreQuery(name, ranked, relevant),
      });
    }
    if (c.task) {
      const ranked = search(entries, c.task, {
        limit: opts.searchLimit ?? EVAL_SEARCH_LIMIT,
      }).map((h) => h.entry.frontmatter.id);
      results.push({
        ...base,
        surface: "search",
        ranked,
        served: ranked,
        score: scoreQuery(name, ranked, relevant),
      });
    }
  });
  const all = surfaceReport(results);
  return {
    cases: results,
    problems,
    session: surfaceReport(results.filter((r) => r.surface === "session")),
    search: surfaceReport(results.filter((r) => r.surface === "search")),
    all,
    sane: mostReachGold(all),
  };
}
