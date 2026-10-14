import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

async function run(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-14T09:00:00Z"),
  });
  return { code, stdout, stderr };
}

function setup() {
  const kb = mkdtempSync(join(tmpdir(), "homeostat-docs-"));
  cpSync(starter, kb, { recursive: true });
  const src = mkdtempSync(join(tmpdir(), "homeostat-docs-src-"));
  writeFileSync(
    join(src, "Architecture.md"),
    "# Architecture\n\nLast updated: 2026-05-01\n\n## Services\nThe API calls the worker through the queue.\n\n<!-- EVIDENCE: [learn] from a design review -->\n\n## Deployment\nEach service ships as a container.\n",
  );
  writeFileSync(
    join(src, "domain.md"),
    "# Partner domain\n\n## Booking Flow\nSearch, quote, book.\n\n## Booking Flow\nA copy left by an old rewrite.\n",
  );
  return { kb, src };
}

describe("homeostat docs convert (K1)", () => {
  test("writes each document under knowledge/<area>/docs/ and validates it", async () => {
    const { kb, src } = setup();
    const { code, stdout } = await run([
      "docs",
      "convert",
      join(src, "Architecture.md"),
      "--area",
      "integrations",
      "--owner",
      "dana",
      "--dir",
      kb,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("wrote knowledge/integrations/docs/architecture.md");
    expect(stdout).toContain("all 1 documents validate");
    const text = readFileSync(join(kb, "knowledge/integrations/docs/architecture.md"), "utf8");
    expect(text).toContain("scope:\n  - services/integrations/**");
    expect(text).toContain("## Services {#services}");
    expect((await run(["validate", kb])).code).toBe(0);
  });

  test("reports the defects a person has to fix, and exits 1", async () => {
    const { kb, src } = setup();
    const { code, stdout } = await run([
      "docs",
      "convert",
      join(src, "domain.md"),
      "--area",
      "core",
      "--owner",
      "dana",
      "--dir",
      kb,
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('heading "Booking Flow" appears on lines');
  });

  test("refuses an unknown area and never overwrites without --force", async () => {
    const { kb, src } = setup();
    const file = join(src, "Architecture.md");
    expect(
      (await run(["docs", "convert", file, "--area", "nope", "--owner", "dana", "--dir", kb]))
        .stderr,
    ).toContain('unknown area "nope"');
    await run(["docs", "convert", file, "--area", "core", "--owner", "dana", "--dir", kb]);
    const again = await run([
      "docs",
      "convert",
      file,
      "--area",
      "core",
      "--owner",
      "dana",
      "--dir",
      kb,
    ]);
    expect(again.stderr).toContain("already exists; use --force");
  });
});
