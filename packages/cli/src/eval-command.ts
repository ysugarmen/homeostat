import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  type CaseResult,
  CUTOFFS,
  EVAL_FILE,
  type EvalReport,
  inRepo,
  isMultiRepo,
  parseEvalCases,
  readKbView,
  repoNames,
  runSelectionEval,
  type SurfaceReport,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { painter, plural } from "./format.ts";
import { findKb, sessionRuleBudget } from "./hook.ts";

export interface EvalCommandOptions {
  dir?: string;
  file?: string;
  json?: boolean;
  /** Floors, e.g. `hit@5=0.8` or `mrr=0.5`; the run fails below any of them. */
  min?: string[];
}

const METRICS = ["hit", "mrr", "ndcg", "recall", "precision"] as const;
type Metric = (typeof METRICS)[number];
const KEY: Record<Metric, keyof SurfaceReport> = {
  hit: "hit",
  mrr: "mrrAt",
  ndcg: "ndcg",
  recall: "recall",
  precision: "precision",
};

interface Floor {
  spec: string;
  value: number;
  read: (r: SurfaceReport) => number;
}

/** `hit@5=0.8`, `ndcg@10=0.6`, `mrr=0.5`, `r-precision=0.4`, `served=0.9`. */
export function parseFloor(spec: string): Floor | string {
  const m = /^([a-z-]+)(?:@(\d+))?=(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(spec.trim().toLowerCase());
  if (!m) return `--min ${spec}: write it as <metric>[@k]=<0..1>, e.g. hit@5=0.8`;
  const [, name, k, v] = m as unknown as [string, string, string | undefined, string];
  const value = Number(v);
  if (k === undefined) {
    if (name === "mrr") return { spec, value, read: (r) => r.mrr };
    if (name === "r-precision") return { spec, value, read: (r) => r.rPrecision };
    if (name === "served") return { spec, value, read: (r) => r.served };
    return `--min ${spec}: ${name} needs a cutoff, e.g. ${name}@5`;
  }
  const cut = Number(k) as (typeof CUTOFFS)[number];
  if (!(METRICS as readonly string[]).includes(name))
    return `--min ${spec}: unknown metric; use ${METRICS.join(", ")}, r-precision or served`;
  if (!CUTOFFS.includes(cut)) return `--min ${spec}: k must be one of ${CUTOFFS.join(", ")}`;
  const key = KEY[name as Metric];
  return { spec, value, read: (r) => (r[key] as Record<number, number>)[cut] ?? 0 };
}

const f3 = (n: number) => n.toFixed(3);

function table(label: string, r: SurfaceReport): string[] {
  if (!r.queries) return [];
  const head = `  ${label.padEnd(12)}${CUTOFFS.map((k) => `@${k}`.padStart(8)).join("")}`;
  const row = (name: string, v: Record<number, number>) =>
    `    ${name.padEnd(10)}${CUTOFFS.map((k) => f3(v[k] ?? 0).padStart(8)).join("")}`;
  return [
    head,
    row("Hit", r.hit),
    row("MRR", r.mrrAt),
    row("nDCG", r.ndcg),
    row("Recall", r.recall),
    row("Precision", r.precision),
    `    R-precision ${f3(r.rPrecision)}  MRR ${f3(r.mrr)}  served ${f3(r.served)}  reached gold ${r.reachedGold}/${r.queries}`,
  ];
}

function caseLine(c: CaseResult, io: Io): string {
  const paint = painter(io);
  const served = c.expect.filter((id) => c.served.includes(id)).length;
  const ok = served === c.expect.length;
  const mark = ok ? paint("green", "✓") : paint("red", "✗");
  const first = c.score.firstHit ? `first gold at ${c.score.firstHit}` : "no gold";
  const missed = c.expect
    .filter((id) => !c.served.includes(id))
    .map((id) => {
      const at = c.ranked.indexOf(id);
      return at < 0 ? id : `${id} (rank ${at + 1})`;
    });
  return `  ${mark} ${c.name}: ${first}, served ${served}/${c.expect.length}${
    missed.length ? paint("dim", `; missed ${missed.join(", ")}`) : ""
  }`;
}

export function formatEval(report: EvalReport, source: string, budget: number, io: Io): string {
  const out = [
    `Selection eval: ${plural(report.cases.length, "scored case")} from ${source} (session budget ${budget} tokens)`,
  ];
  for (const surface of ["session", "search"] as const) {
    const cases = report.cases.filter((c) => c.surface === surface);
    if (!cases.length) continue;
    out.push("", surface === "session" ? "Session (paths)" : "Search (task)");
    out.push(...cases.map((c) => caseLine(c, io)));
  }
  out.push(
    "",
    ...table("session", report.session),
    ...table("search", report.search),
    ...(report.session.queries && report.search.queries ? table("all", report.all) : []),
  );
  return `${out.join("\n")}\n`;
}

/**
 * `homeostat eval`: runs the KB's selection cases through the code sessions and search use and
 * prints hits and ranking metrics. Exits 1 only on a broken fixture or a missed `--min` floor.
 */
export function runEval(opts: EvalCommandOptions, io: Io): number {
  const root = opts.dir ? resolve(opts.dir) : findKb(io.env, process.cwd());
  if (!root) {
    io.stderr("no knowledge base here: pass --dir, set HOMEOSTAT_DIR, or run inside the KB repo\n");
    return 1;
  }
  const file = opts.file ? resolve(opts.file) : resolve(root, EVAL_FILE);
  if (!existsSync(file)) {
    io.stderr(
      `no selection cases at ${file}. Write ${EVAL_FILE} with a list of cases, e.g.\n\ncases:\n  - paths: [services/billing/tax.ts]\n    expect: [billing-tax-per-line]\n  - task: round tax on each line\n    expect: [billing-tax-per-line]\n`,
    );
    return 1;
  }
  const floors = (opts.min ?? []).map(parseFloor);
  const badFloor = floors.find((x): x is string => typeof x === "string");
  if (badFloor) {
    io.stderr(`${badFloor}\n`);
    return 1;
  }
  const { cases, issues } = parseEvalCases(readFileSync(file, "utf8"));
  if (issues.length) {
    io.stderr(`${file}:\n${issues.map((i) => `  ${i.message}`).join("\n")}\n`);
    return 1;
  }
  // The same view of the KB the session hook reads.
  const { config, entries, docs } = validate(readKbView(root, { inForce: true }).files, {
    checks: false,
  });
  if (!config) {
    io.stderr(`homeostat.yaml is missing or invalid in ${root}; run homeostat validate\n`);
    return 1;
  }
  const placed = entries.map((e) => ({ ...e.entry, path: e.path }));
  const { tokenBudget, maxChars } = sessionRuleBudget(config, docs.length > 0);
  const report = runSelectionEval(
    cases,
    {
      entries: (repo) => inRepo(placed, config, repo),
      ...(isMultiRepo(config) ? { repos: repoNames(config) } : {}),
    },
    { tokenBudget, maxChars },
  );

  const failures = [...report.problems];
  if (!report.problems.length && !report.sane) {
    failures.push(
      `only ${report.all.reachedGold} of ${report.all.queries} cases reached any expected rule: the cases are likely wrong (paths, repo or ids), not the ranking`,
    );
  }
  const missed = floors
    .filter((x): x is Exclude<typeof x, string> => typeof x !== "string")
    .filter((x) => x.read(report.all) < x.value)
    .map((x) => `below --min ${x.spec}: ${f3(x.read(report.all))}`);

  if (opts.json) {
    io.stdout(
      `${JSON.stringify(
        {
          file: relative(root, file) || file,
          tokenBudget,
          problems: failures,
          belowFloor: missed,
          session: strip(report.session),
          search: strip(report.search),
          all: strip(report.all),
          cases: report.cases.map((c) => ({
            name: c.name,
            surface: c.surface,
            ...(c.repo ? { repo: c.repo } : {}),
            expect: c.expect,
            firstHit: c.score.firstHit ?? null,
            served: c.expect.filter((id) => c.served.includes(id)),
            top: c.ranked.slice(0, 10),
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout(formatEval(report, relative(root, file) || file, tokenBudget, io));
    for (const line of [...failures, ...missed]) io.stderr(`${line}\n`);
  }
  return failures.length || missed.length ? 1 : 0;
}

const strip = (r: SurfaceReport) => ({
  queries: r.queries,
  hit: r.hit,
  mrr: r.mrrAt,
  ndcg: r.ndcg,
  recall: r.recall,
  precision: r.precision,
  mrrUntruncated: r.mrr,
  rPrecision: r.rPrecision,
  served: r.served,
  reachedGold: r.reachedGold,
});
