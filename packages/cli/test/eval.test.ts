import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIXTURE_CASES, FIXTURE_CONFIG, fixtureRules } from "@homeostat/core/eval-fixture";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { parseFloor } from "../src/eval-command.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

function starter(cases: string) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-eval-"));
  cpSync(join(examples, "starter-multi-kb"), dir, { recursive: true });
  mkdirSync(join(dir, "eval"));
  writeFileSync(join(dir, "eval/selection.yaml"), cases);
  return dir;
}

async function run(dir: string, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", "eval", "--dir", dir, ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
  });
  return { code, stdout, stderr };
}

const CASES = `cases:
  - name: retry helper
    repo: api
    paths: [services/integrations/partner.ts]
    expect: [outbound-http-retry-helper]
  - name: partner calls
    repo: api
    paths: [packages/http-client/get.ts]
    task: retry partner http calls
    expect: [outbound-http-retry-helper]
  - name: logging
    task: redact secrets before logging
    expect: [redact-before-logging]
`;

describe("homeostat eval", () => {
  test("prints each case and the metrics at 1, 3, 5 and 10", async () => {
    const { code, stdout, stderr } = await run(starter(CASES));
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("Selection eval: 4 scored cases from eval/selection.yaml");
    expect(stdout).toContain("✓ retry helper: first gold at 1, served 1/1");
    expect(stdout).toMatch(/session\s+@1\s+@3\s+@5\s+@10/);
    expect(stdout).toMatch(/Hit\s+1\.000/);
  });

  test("--json carries the cases and the aggregates", async () => {
    const { code, stdout } = await run(starter(CASES), "--json");
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.cases.map((c: { surface: string }) => c.surface)).toEqual([
      "session",
      "session",
      "search",
      "search",
    ]);
    expect(json.all).toMatchObject({ queries: 4, mrrUntruncated: 1, reachedGold: 4 });
    expect(json.problems).toEqual([]);
  });

  test("an unknown rule id or repo fails the run", async () => {
    const dir = starter(
      "cases:\n  - repo: api\n    paths: [a.ts]\n    expect: [no-such-rule]\n  - repo: ios\n    paths: [a.ts]\n    expect: [redact-before-logging]\n",
    );
    const { code, stderr } = await run(dir);
    expect(code).toBe(1);
    expect(stderr).toContain('case 1: no rule "no-such-rule" in repo api or the shared rules');
    expect(stderr).toContain('case 2: unknown repo "ios"');
  });

  test("cases that mostly reach no expected rule fail as a broken fixture", async () => {
    const dir = starter(
      "cases:\n  - repo: api\n    paths: [docs/readme.md]\n    expect: [outbound-http-retry-helper]\n  - task: nothing matches this\n    expect: [redact-before-logging]\n",
    );
    const { code, stderr } = await run(dir);
    expect(code).toBe(1);
    expect(stderr).toContain("cases reached any expected rule");
  });

  test("--min fails below a floor; a malformed floor is an error", async () => {
    const dir = starter(CASES);
    expect((await run(dir, "--min", "hit@1=0.5", "served=1")).code).toBe(0);
    const below = await run(dir, "--min", "precision@10=0.5");
    expect(below.code).toBe(1);
    expect(below.stderr).toContain("below --min precision@10=0.5: 0.100");
    const bad = await run(dir, "--min", "hit=0.5");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("hit needs a cutoff");
    expect(parseFloor("ndcg@7=0.5")).toBe("--min ndcg@7=0.5: k must be one of 1, 3, 5, 10");
  });

  test("with no cases file, says where to put one and what it looks like", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homeostat-eval-"));
    cpSync(join(examples, "starter-kb"), dir, { recursive: true });
    const { code, stderr } = await run(dir);
    expect(code).toBe(1);
    expect(stderr).toContain("no selection cases at");
    expect(stderr).toContain("expect: [billing-tax-per-line]");
    const broken = starter("cases:\n  - expect: [x]\n");
    expect((await run(broken)).stderr).toContain("cases.0: needs paths, task or both");
  });

  test("runs the built-in fixture from disk, through the session's own loader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "homeostat-eval-fixture-"));
    for (const r of fixtureRules()) {
      mkdirSync(dirname(join(dir, r.path)), { recursive: true });
      writeFileSync(join(dir, r.path), r.text);
    }
    writeFileSync(join(dir, "homeostat.yaml"), FIXTURE_CONFIG);
    mkdirSync(join(dir, "eval"));
    writeFileSync(join(dir, "eval/selection.yaml"), JSON.stringify({ cases: FIXTURE_CASES }));
    const { code, stdout } = await run(dir, "--json");
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.tokenBudget).toBe(1600);
    expect(json.all.reachedGold).toBe(json.all.queries);
  });
});
