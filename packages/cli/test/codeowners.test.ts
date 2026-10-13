import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
  });
  return { code, stdout, stderr };
}

function copyKb(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-"));
  cpSync(join(examples, name), dir, { recursive: true });
  return dir;
}

describe("homeostat codeowners", () => {
  test("the committed starter-kb CODEOWNERS is up to date", async () => {
    const { code, stdout } = await run("codeowners", join(examples, "starter-kb"), "--check");
    expect(stdout).toBe("CODEOWNERS is up to date\n");
    expect(code).toBe(0);
  });

  test("writes CODEOWNERS at the KB root", async () => {
    const dir = copyKb("starter-kb");
    writeFileSync(join(dir, "CODEOWNERS"), "stale\n");
    const { code, stdout } = await run("codeowners", dir);
    expect(code).toBe(0);
    expect(stdout).toBe("wrote CODEOWNERS\n");
    expect(readFileSync(join(dir, "CODEOWNERS"), "utf8")).toBe(
      readFileSync(join(examples, "starter-kb/CODEOWNERS"), "utf8"),
    );
  });

  test("--check fails without writing when the file is stale or missing", async () => {
    const dir = copyKb("starter-kb");
    writeFileSync(join(dir, "CODEOWNERS"), "stale\n");
    const stale = await run("codeowners", dir, "--check");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toBe("CODEOWNERS is out of date; run homeostat codeowners\n");
    expect(readFileSync(join(dir, "CODEOWNERS"), "utf8")).toBe("stale\n");
  });

  test("refuses to generate from an invalid KB", async () => {
    const dir = copyKb("broken-kb");
    const { code, stdout } = await run("codeowners", dir);
    expect(code).toBe(1);
    expect(stdout).toContain("fix the errors above");
    expect(existsSync(join(dir, "CODEOWNERS"))).toBe(false);
  });

  test("a member without a handle is reported against homeostat.yaml", async () => {
    const dir = copyKb("starter-kb");
    const config = join(dir, "homeostat.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace(/\n\s+handle: "@lee"/, ""));
    const { code, stdout } = await run("codeowners", dir);
    expect(code).toBe(1);
    expect(stdout).toContain('team member "lee" owns files but has no handle');
  });
});
