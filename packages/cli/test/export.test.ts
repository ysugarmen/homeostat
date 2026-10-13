import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", "export", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
  });
  return { code, stdout, stderr };
}

const codeRepo = () => mkdtempSync(join(tmpdir(), "homeostat-export-"));
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const write = (dir: string, path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

describe("homeostat export", () => {
  test("writes every configured target into the code repo", async () => {
    const out = codeRepo();
    const { code, stdout } = await run("--kb", starter, "--out", out);
    expect(code).toBe(0);
    for (const path of [
      ".claude/rules/homeostat/core.md",
      ".claude/rules/homeostat/integrations.md",
      ".cursor/rules/homeostat/core.mdc",
      ".cursor/rules/homeostat/integrations.mdc",
      ".github/instructions/homeostat/integrations.instructions.md",
      ".github/copilot-instructions.md",
      "AGENTS.md",
    ]) {
      expect(existsSync(join(out, path)), path).toBe(true);
      expect(stdout).toContain(`wrote ${path}`);
    }
  });

  test("keeps hand-written AGENTS.md content and is idempotent", async () => {
    const out = codeRepo();
    write(out, "AGENTS.md", "# Our repo\n\nRun pnpm test before pushing.\n");
    await run("--kb", starter, "--out", out);
    const first = read(out, "AGENTS.md");
    expect(
      first.startsWith("# Our repo\n\nRun pnpm test before pushing.\n\n<!-- homeostat:start"),
    ).toBe(true);
    const again = await run("--kb", starter, "--out", out);
    expect(read(out, "AGENTS.md")).toBe(first);
    expect(again.stdout).toBe("exported rules are up to date\n");
  });

  test("removes stale files in homeostat's own folders, and nothing else", async () => {
    const out = codeRepo();
    write(out, ".claude/rules/homeostat/payments.md", "old");
    write(out, ".claude/rules/mine.md", "hand-written");
    const { stdout } = await run("--kb", starter, "--out", out);
    expect(existsSync(join(out, ".claude/rules/homeostat/payments.md"))).toBe(false);
    expect(read(out, ".claude/rules/mine.md")).toBe("hand-written");
    expect(stdout).toContain("removed .claude/rules/homeostat/payments.md");
  });

  test("--target limits what is written", async () => {
    const out = codeRepo();
    await run("--kb", starter, "--out", out, "--target", "cursor");
    expect(existsSync(join(out, ".cursor/rules/homeostat/core.mdc"))).toBe(true);
    expect(existsSync(join(out, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(out, ".claude"))).toBe(false);
  });

  test("an unknown target is refused", async () => {
    const { code, stderr } = await run("--kb", starter, "--out", codeRepo(), "--target", "zed");
    expect(code).toBe(1);
    expect(stderr).toContain('unknown target "zed"; use claude, cursor, agents-md or copilot');
  });

  test("--check reports drift without writing", async () => {
    const out = codeRepo();
    const stale = await run("--kb", starter, "--out", out, "--check");
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain("out of date: AGENTS.md");
    expect(existsSync(join(out, "AGENTS.md"))).toBe(false);

    await run("--kb", starter, "--out", out);
    expect((await run("--kb", starter, "--out", out, "--check")).code).toBe(0);
  });

  test("when homeostat's block is all that is left of a shared file, the file goes", async () => {
    const out = codeRepo();
    await run("--kb", starter, "--out", out, "--target", "agents-md");
    const empty = mkdtempSync(join(tmpdir(), "homeostat-emptykb-"));
    write(empty, "homeostat.yaml", read(starter, "homeostat.yaml"));
    const { stdout } = await run("--kb", empty, "--out", out, "--target", "agents-md");
    expect(existsSync(join(out, "AGENTS.md"))).toBe(false);
    expect(stdout).toContain("removed AGENTS.md");
  });

  test("an invalid KB is refused", async () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-badkb-"));
    write(kb, "homeostat.yaml", "version: [");
    const { code, stderr } = await run("--kb", kb, "--out", codeRepo());
    expect(code).toBe(1);
    expect(stderr).toContain("homeostat.yaml is missing or invalid");
  });
});
