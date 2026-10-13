import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "kbx", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
  });
  return { code, stdout, stderr };
}

function copyKb(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "kbx-"));
  cpSync(join(examples, name), dir, { recursive: true });
  return dir;
}

describe("kbx validate", () => {
  test("exits 0 on a valid KB", async () => {
    const { code, stdout } = await run("validate", join(examples, "starter-kb"));
    expect(code).toBe(0);
    expect(stdout).toContain("3 entries, no problems");
  });

  test("exits 1 and groups errors by file on a broken KB", async () => {
    const { code, stdout } = await run("validate", join(examples, "broken-kb"));
    expect(code).toBe(1);
    expect(stdout).toMatchInlineSnapshot(`
      "knowledge/integrations/Retry_Everything.md
        error  title: must be at most 80 characters  schema
        error  created: must be a real calendar date  schema
        error  vertical: unknown key; did you mean "area"?  schema
        error  text before the first section; start the body with ## Rule  body.preamble
        error  unknown section "## Notes"; allowed: Rule, Why, Example  body.section.unknown
        error  missing or empty ## Why section  body.why.missing

      6 errors, 0 warnings in 1 file (0 entries parsed)
      "
    `);
  });

  test("defaults to the current directory", async () => {
    const cwd = process.cwd();
    process.chdir(join(examples, "starter-kb"));
    try {
      expect((await run("validate")).code).toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  test("a directory with no kbx.yaml says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kbx-"));
    const { code, stdout } = await run("validate", dir);
    expect(code).toBe(1);
    expect(stdout).toContain("no kbx.yaml at the KB root");
  });

  test("warnings do not fail, and point at --fix", async () => {
    const dir = copyKb("starter-kb");
    const file = join(dir, "knowledge/integrations/outbound-http-retry-helper.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("score: 4", "score: 9"));
    const { code, stdout } = await run("validate", dir);
    expect(code).toBe(0);
    expect(stdout).toContain("warning  score is 9, computed 4");
    expect(stdout).toContain("1 fixable; run kbx validate --fix");
  });

  test("--fix rewrites stale score and tokens, then re-validates", async () => {
    const dir = copyKb("starter-kb");
    const file = join(dir, "knowledge/integrations/outbound-http-retry-helper.md");
    const original = readFileSync(file, "utf8");
    writeFileSync(
      file,
      original.replace("score: 4", "score: 9").replace(/tokens: \d+/, "tokens: 1"),
    );
    const { code, stdout } = await run("validate", dir, "--fix");
    expect(code).toBe(0);
    expect(stdout).toContain("fixed 2 fields in 1 file");
    expect(stdout).toContain("3 entries, no problems");
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("--json prints machine-readable output", async () => {
    const { code, stdout } = await run("validate", join(examples, "broken-kb"), "--json");
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.entries).toBe(0);
    expect(parsed.issues[0]).toMatchObject({ severity: "error", file: expect.any(String) });
  });
});
