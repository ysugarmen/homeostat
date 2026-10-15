import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEntry } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const PATH = "knowledge/core/redact-before-logging.md";

function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-flag-"));
  cpSync(starter, dir, { recursive: true });
  return dir;
}

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", "flag", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-14T09:00:00Z"),
  });
  return { code, stdout, stderr };
}

describe("homeostat flag", () => {
  test("adds the flag in the working tree and sends the entry to review", async () => {
    const dir = kb();
    const { code, stdout } = await run(
      "redact-before-logging",
      "--dir",
      dir,
      "--by",
      "lee",
      "--reason",
      "redact() was renamed to scrub()",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("it no longer applies to your sessions (disputed)");
    // The flag goes to the pending area; the tracked file is untouched until the daily run.
    const fm = parseEntry(readFileSync(join(dir, ".homeostat/pending", PATH), "utf8")).entry
      ?.frontmatter;
    expect(fm?.flags).toEqual([
      { by: "lee", reason: "redact() was renamed to scrub()", date: "2026-10-14" },
    ]);
    expect(fm?.status).toBe("disputed");
    expect(fm?.score).toBe(0);
  });

  test("--branch commits it without touching the checkout", async () => {
    const dir = kb();
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@e.com", "commit", "-qm", "init");
    const { code } = await run(
      "redact-before-logging",
      "--dir",
      dir,
      "--by",
      "sam",
      "--reason",
      "r",
      "--branch",
      "candidates/sam",
    );
    expect(code).toBe(0);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", `candidates/sam:${PATH}`)).toContain("by: sam");
  });

  test("a reason is required, and the id and member must exist", async () => {
    const dir = kb();
    expect((await run("redact-before-logging", "--dir", dir, "--by", "lee")).stderr).toContain(
      "--reason is required",
    );
    expect((await run("nope", "--dir", dir, "--by", "lee", "--reason", "r")).stderr).toContain(
      'no entry with id "nope"',
    );
    expect(
      (await run("redact-before-logging", "--dir", dir, "--by", "ghost", "--reason", "r")).stderr,
    ).toContain('"ghost" is not a team member');
  });
});
