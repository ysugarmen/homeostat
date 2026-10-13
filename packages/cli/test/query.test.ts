import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: { HOMEOSTAT_DIR: starter },
    now: () => new Date("2026-10-14T09:00:00Z"),
  });
  return { code, stdout, stderr };
}

describe("read-only commands", () => {
  test("search finds by topic, as text or JSON", async () => {
    const { code, stdout } = await run("search", "retry", "partner", "http");
    expect(code).toBe(0);
    expect(stdout.split("\n")[0]).toContain("outbound-http-retry-helper");
    const json = JSON.parse((await run("search", "redact", "--json")).stdout);
    expect(json[0]).toMatchObject({ id: "redact-before-logging", status: "accepted" });
  });

  test("search --all includes candidates", async () => {
    expect((await run("search", "dark", "mode")).stdout).toBe("no matching entries\n");
    expect((await run("search", "colour", "tokens", "--all")).stdout).toContain(
      "use-design-tokens-for-colors",
    );
  });

  test("explain shows the score breakdown and source; a wrong id suggests the closest", async () => {
    const { stdout } = await run("explain", "outbound-http-retry-helper");
    expect(stdout).toContain(
      "score 4 (+3 review comment led to a code change, +1 author dana is senior)",
    );
    const miss = await run("explain", "retry-helper");
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain("closest: outbound-http-retry-helper");
  });

  test("list shows every entry with status and score, filterable", async () => {
    const { stdout } = await run("list");
    expect(stdout.trim().split("\n")).toHaveLength(3);
    expect((await run("list", "--status", "candidate")).stdout).toContain(
      "use-design-tokens-for-colors",
    );
    expect((await run("list", "--status", "nope")).stderr).toContain("--status must be one of");
  });

  test("status reports KB health", async () => {
    const { stdout } = await run("status", "--days", "30");
    expect(stdout).toContain("Entries: 3 (");
    expect(stdout).toContain("Stale (not confirmed in 180 days): 0");
  });

  test("with no KB anywhere, the message says how to point at one", async () => {
    let stderr = "";
    const cwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "homeostat-nokb-")));
    try {
      await runCli(["node", "homeostat", "list"], {
        stdout: () => {},
        stderr: (s) => (stderr += s),
        color: false,
        env: {},
      });
    } finally {
      process.chdir(cwd);
    }
    expect(stderr).toContain("pass --dir, set HOMEOSTAT_DIR, or run inside the KB repo");
  });
});

describe("desire-path aliases", () => {
  test.each([
    ["show", "outbound-http-retry-helper"],
    ["why", "outbound-http-retry-helper"],
    ["find", "retry"],
    ["ls"],
    ["report"],
    ["health"],
  ])("homeostat %s works", async (...args) => {
    expect((await run(...args)).code).toBe(0);
  });

  test("check and lint are validate", async () => {
    expect((await run("check", starter)).stdout).toContain("3 entries, no problems");
    expect((await run("lint", starter)).code).toBe(0);
  });

  test("an unknown command gets commander's suggestion", async () => {
    const { code, stderr } = await run("serch", "x");
    expect(code).toBe(1);
    expect(stderr).toContain("Did you mean search?");
  });
});

test("add and remember are learn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-add-"));
  writeFileSync(
    join(dir, "homeostat.yaml"),
    "version: 1\nteam: { members: [{ id: a, role: senior }] }\nareas: {}\n",
  );
  let stdout = "";
  const code = await runCli(
    [
      "node",
      "homeostat",
      "add",
      "--dir",
      dir,
      "--title",
      "Do X",
      "--rule",
      "Do X always.",
      "--why",
      "Y.",
      "--author",
      "a",
    ],
    { stdout: (s) => (stdout += s), stderr: () => {}, color: false, env: {} },
  );
  expect(code).toBe(0);
  expect(stdout).toContain("created knowledge/core/do-x.md");
});
