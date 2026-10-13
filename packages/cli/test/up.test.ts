import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

async function up(now: string, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "kbx-up-"));
  cpSync(starter, dir, { recursive: true });
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "kbx", "up", "--dir", dir, ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date(now),
  });
  return { code, stdout, stderr };
}

describe("kbx up", () => {
  test("--once runs the curator at its scheduled minute", async () => {
    const { stdout, stderr } = await up("2026-10-13T06:00:00Z", "--once");
    expect(stdout).toContain("running curator");
    // No token in the test env: proves the curator itself ran.
    expect(stderr).toContain("set KBX_BITBUCKET_TOKEN");
  });

  test("--once outside any schedule runs nothing", async () => {
    const { code, stdout, stderr } = await up("2026-10-13T06:01:00Z", "--once");
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("the deep dive runs on Monday mornings", async () => {
    const { stdout } = await up("2026-10-12T07:00:00Z", "--once");
    expect(stdout).toContain("running deepDive");
    expect(stdout).not.toContain("running curator");
  });

  test("--run-now runs every enabled agent", async () => {
    const { stdout } = await up("2026-10-13T12:34:00Z", "--run-now");
    expect(stdout).toContain("running curator");
    expect(stdout).toContain("running deepDive");
  });
});

test("without a reachable Claude the agents stop with a clear message", async () => {
  const { stderr } = await up("2026-10-12T07:00:00Z", "--once");
  expect(stderr).toContain("Claude Code (claude) is not installed");
});
