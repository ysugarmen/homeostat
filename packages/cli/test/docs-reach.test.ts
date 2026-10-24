import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-reach-"));
  cpSync(starter, dir, { recursive: true });
  return dir;
}

function codeRepo(file: string) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-reach-code-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), "x");
  return dir;
}

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: {},
    ...extra,
  });
  return { code, stdout };
}

describe("documents reach agents (K6)", () => {
  test("a session touching an area is told how many documents cover it, and gets the sections that name its files", async () => {
    const dir = kb();
    const cwd = codeRepo("services/integrations/partner.ts");
    const { stdout } = await run(["hook", "session-start"], {
      env: { HOMEOSTAT_DIR: dir },
      stdin: async () => JSON.stringify({ session_id: "s1", cwd }),
    });
    const context: string = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("# Team document sections for your files (homeostat)");
    expect(context).toContain("## Timeouts (integrations/partner-calls#timeouts)");
    // Counted, not listed: titles up front are picked from instead of searched.
    expect(context).toMatch(/1 team document covers? this code \(integrations 1\)/);
    expect(context).not.toContain("Partner API calls (");
    expect(context).toContain("`read`");
    const [e] = readEvents(dir, { types: ["doc-injection"] });
    expect(e).toMatchObject({
      docs: ["integrations/partner-calls"],
      sections: [
        { doc: "integrations/partner-calls", id: "http-client" },
        { doc: "integrations/partner-calls", id: "timeouts" },
      ],
    });
  });

  test("a session elsewhere gets no documents", async () => {
    const dir = kb();
    const cwd = codeRepo("apps/web/src/App.tsx");
    const { stdout } = await run(["hook", "session-start"], {
      env: { HOMEOSTAT_DIR: dir },
      stdin: async () => JSON.stringify({ session_id: "s2", cwd }),
    });
    expect(stdout).not.toContain("Team document");
  });

  test("export writes each tool's scoped document file and lists them in AGENTS.md", async () => {
    const out = codeRepo("README.md");
    const { code } = await run(["export", "--kb", kb(), "--out", out]);
    expect(code).toBe(0);
    const claude = readFileSync(
      join(out, ".claude/rules/homeostat/docs/integrations-partner-calls.md"),
      "utf8",
    );
    expect(claude).toMatch(/^---\npaths:\n {2}- "services\/integrations\/\*\*"\n---/);
    expect(claude).toContain("## The shared HTTP client");
    expect(claude).not.toContain("homeostat: source="); // provenance stays in the KB
    expect(
      readFileSync(
        join(out, ".cursor/rules/homeostat/docs-integrations-partner-calls.mdc"),
        "utf8",
      ),
    ).toContain("globs: services/integrations/**");
    const agents = readFileSync(join(out, "AGENTS.md"), "utf8");
    expect(agents).toContain(
      "`.agents/homeostat/integrations-partner-calls.md`: Partner API calls",
    );
    expect(
      readFileSync(join(out, ".agents/homeostat/integrations-partner-calls.md"), "utf8"),
    ).toContain("# Partner API calls");
  });
});
