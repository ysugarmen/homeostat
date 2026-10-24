import { describe, expect, test } from "vitest";
import { parseEvalCases, runSelectionEval } from "../src/selection-eval.ts";
import {
  FIXTURE_BUDGET,
  FIXTURE_CASES,
  FIXTURE_REPOS,
  fixturePool,
  fixtureRules,
} from "./selection-fixture.ts";

const rules = fixtureRules();
const pool = {
  entries: (repo: string | undefined) => fixturePool(rules, repo),
  repos: FIXTURE_REPOS,
};
const run = () => runSelectionEval(FIXTURE_CASES, pool, { tokenBudget: FIXTURE_BUDGET });

describe("eval cases file", () => {
  test("reads cases with paths, task, repo and expect", () => {
    const { cases, issues } = parseEvalCases(
      "cases:\n  - name: tax\n    paths: [services/billing/tax.ts]\n    repo: api\n    expect: [billing-tax-per-line]\n  - task: round tax\n    expect: [billing-tax-per-line]\n",
    );
    expect(issues).toEqual([]);
    expect(cases).toHaveLength(2);
    expect(cases[1]).toEqual({ task: "round tax", expect: ["billing-tax-per-line"] });
  });

  test("a case needs paths or a task, and at least one expected rule", () => {
    const { issues } = parseEvalCases(
      "cases:\n  - expect: [a]\n  - paths: [x.ts]\n    expect: []\n",
    );
    expect(issues.map((i) => i.message)).toEqual([
      "cases.0: needs paths, task or both",
      "cases.1.expect: must name at least one rule id",
    ]);
    expect(parseEvalCases("cases: [").issues[0]?.message).toMatch(/^not valid YAML/);
    expect(
      parseEvalCases("cases:\n  - paths: [a]\n    expect: [b]\n    extra: 1\n").issues,
    ).toHaveLength(1);
  });
});

describe("runSelectionEval", () => {
  test("names unknown ids, rules that are never served, and unknown repos", () => {
    const report = runSelectionEval(
      [
        {
          name: "typo",
          repo: "api",
          paths: ["services/billing/tax.ts"],
          expect: ["billing-tax-per-lin"],
        },
        { name: "other repo", repo: "web", paths: ["a.ts"], expect: ["billing-tax-per-line"] },
        { name: "candidate", paths: ["a.ts"], expect: ["core-draft-retry-everything"] },
        { name: "rejected", task: "graphql", expect: ["core-graphql-public-api"] },
        { name: "nowhere", repo: "mobile", paths: ["a.ts"], expect: ["core-timezones"] },
      ],
      pool,
      { tokenBudget: FIXTURE_BUDGET },
    );
    expect(report.problems).toEqual([
      'typo: no rule "billing-tax-per-lin" in repo api or the shared rules',
      'other repo: no rule "billing-tax-per-line" in repo web or the shared rules',
      'candidate: rule "core-draft-retry-everything" is candidate, never served',
      'rejected: rule "core-graphql-public-api" is a rejected decision, never served',
      'nowhere: unknown repo "mobile" (repos: api, web)',
    ]);
    expect(report.cases).toEqual([]);
  });

  test("a case with paths and a task is scored on both surfaces", () => {
    const report = runSelectionEval(
      [
        {
          repo: "api",
          paths: ["services/billing/tax.ts"],
          task: "round tax per line",
          expect: ["billing-tax-per-line"],
        },
      ],
      pool,
      { tokenBudget: FIXTURE_BUDGET },
    );
    expect(report.cases.map((c) => c.surface)).toEqual(["session", "search"]);
    expect(report.search.mrr).toBe(1);
    // A session ranks everything that applies: what was served, then the rest.
    const session = report.cases[0];
    expect(session?.ranked.slice(0, session.served.length)).toEqual(session?.served);
    expect(session?.ranked.length).toBeGreaterThan(session?.served.length ?? 0);
  });

  test("most cases reaching no gold marks the run as not sane", () => {
    const report = runSelectionEval(
      [
        { paths: ["nothing/here.ts"], expect: ["core-ci-cache"] },
        { paths: ["nothing/here.ts"], expect: ["core-test-factories"] },
        { task: "timezones utc", expect: ["core-timezones"] },
      ],
      pool,
      { tokenBudget: FIXTURE_BUDGET },
    );
    expect(report.all.reachedGold).toBe(1);
    expect(report.sane).toBe(false);
  });
});

describe("the built-in selection fixture", () => {
  test("is about 150 rules across two repos and 25 to 40 cases, all usable", () => {
    expect(rules.length).toBe(150);
    expect(new Set(rules.map((r) => r.entry.frontmatter.id)).size).toBe(rules.length);
    expect(FIXTURE_CASES.length).toBeGreaterThanOrEqual(25);
    expect(FIXTURE_CASES.length).toBeLessThanOrEqual(40);
    const report = run();
    expect(report.problems).toEqual([]);
    expect(report.sane).toBe(true);
  });

  // Floors under the recorded numbers (docs/guide/eval.md lists them): a ranking change that
  // drops below one has made selection worse on cases a team would care about.
  test("selection stays at or above its recorded numbers", () => {
    const { session, search } = run();
    expect(session.mrr).toBeGreaterThanOrEqual(0.85);
    expect(session.hit[1]).toBeGreaterThanOrEqual(0.8);
    expect(session.hit[10]).toBeGreaterThanOrEqual(0.95);
    expect(session.served).toBe(1);
    expect(search.hit[1]).toBeGreaterThanOrEqual(0.9);
    expect(search.served).toBe(1);
  });
});
