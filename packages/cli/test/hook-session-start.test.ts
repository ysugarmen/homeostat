import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countTokens, type Frontmatter, formatEntry, readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

/** The starter KB plus seven more accepted entries: ten in total, as in the 2.3 "done when". */
function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-kb-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  const extra: [string, string, string[], number][] = [
    ["api-timeouts", "integrations", ["services/integrations/**"], 4],
    ["api-idempotency", "integrations", ["services/integrations/queue/**"], 5],
    ["web-a11y", "frontend", ["apps/web/**/*.tsx"], 3],
    ["web-no-inline-styles", "frontend", ["apps/web/**"], 3],
    ["ui-storybook", "frontend", ["packages/ui/**"], 4],
    ["core-conventional-commits", "core", ["**"], 3],
    ["core-no-console", "core", ["services/**"], 3],
  ];
  for (const [id, area, scope, score] of extra) {
    const body = `## Rule\nRule for ${id}.\n\n## Why\nBecause of ${id}.`;
    const fm: Frontmatter = {
      id,
      title: `Title for ${id}`,
      area,
      scope,
      status: "accepted",
      score,
      owner: "dana",
      approvedBy: "dana",
      source: { type: "manual", author: "dana" },
      created: "2026-10-01",
      lastConfirmed: "2026-10-01",
      tokens: countTokens(body),
    };
    const path = join(dir, "knowledge", area, `${id}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatEntry(fm, body));
  }
  return dir;
}

function codeRepo(changed: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-code-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  for (const path of changed) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "x");
  }
  return dir;
}

async function hook(event: string, input: object, env: Record<string, string>) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env,
    stdin: async () => JSON.stringify(input),
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
  const code = await runCli(["node", "homeostat", "hook", event], io);
  return { code, stdout, stderr };
}

const contextOf = (stdout: string): string =>
  JSON.parse(stdout).hookSpecificOutput.additionalContext;

describe("homeostat hook session-start", () => {
  test("injects only the entries relevant to the touched files, best first", async () => {
    const kbDir = kb();
    const cwd = codeRepo(["services/integrations/queue/worker.ts"]);
    const { code, stdout } = await hook(
      "session-start",
      { session_id: "s1", cwd, source: "startup", hook_event_name: "SessionStart" },
      { CLAUDE_PLUGIN_OPTION_KB_DIR: kbDir },
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ids = [...contextOf(stdout).matchAll(/^## .+ \(([a-z0-9-]+)\)$/gm)].map((m) => m[1]);
    expect(ids).toEqual([
      "api-idempotency",
      "outbound-http-retry-helper",
      "api-timeouts",
      "core-no-console",
      "core-conventional-commits",
      "redact-before-logging",
    ]);
  });

  test("stays under the configured token budget", async () => {
    const kbDir = kb();
    const config = join(kbDir, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "tokenBudget: 2000",
        "tokenBudget: 150\n  docTokenBudget: 0",
      ),
    );
    const cwd = codeRepo(["services/integrations/queue/worker.ts"]);
    const { stdout } = await hook(
      "session-start",
      { session_id: "s1", cwd },
      {
        CLAUDE_PLUGIN_OPTION_KB_DIR: kbDir,
      },
    );
    expect(countTokens(contextOf(stdout))).toBeLessThanOrEqual(150);
  });

  test("logs what was injected to the KB's event store", async () => {
    const kbDir = kb();
    const cwd = codeRepo(["apps/web/src/App.tsx"]);
    await hook(
      "session-start",
      { session_id: "s9", cwd, source: "startup" },
      { HOMEOSTAT_DIR: kbDir },
    );
    const [event] = readEvents(kbDir);
    expect(event).toMatchObject({
      ts: "2026-10-13T12:00:00.000Z",
      type: "injection",
      session: "s9",
      source: "startup",
      entries: expect.arrayContaining([{ id: "web-a11y", form: "full" }]),
      dropped: [],
    });
  });

  test("with no KB configured it stays silent and succeeds", async () => {
    const { code, stdout, stderr } = await hook("session-start", { cwd: codeRepo([]) }, {});
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("a broken KB never fails the session", async () => {
    const kbDir = kb();
    writeFileSync(join(kbDir, "homeostat.yaml"), "version: [");
    const { code, stdout, stderr } = await hook(
      "session-start",
      { cwd: codeRepo([]) },
      {
        HOMEOSTAT_DIR: kbDir,
      },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("homeostat: knowledge base config is invalid");
  });

  test("malformed hook input never fails the session", async () => {
    let stderr = "";
    const code = await runCli(["node", "homeostat", "hook", "session-start"], {
      stdout: () => {},
      stderr: (s) => (stderr += s),
      color: false,
      stdin: async () => "not json",
    });
    expect(code).toBe(0);
    expect(stderr).toContain("homeostat:");
  });
});

test("inside an agent's own claude -p call the hooks do nothing", async () => {
  const kbDir = kb();
  const cwd = codeRepo(["services/integrations/queue/worker.ts"]);
  const { code, stdout } = await hook(
    "session-start",
    { session_id: "a", cwd },
    {
      HOMEOSTAT_DIR: kbDir,
      HOMEOSTAT_AGENT: "1",
    },
  );
  expect(code).toBe(0);
  expect(stdout).toBe("");
});

describe("findKb", () => {
  test("an empty or unexpanded plugin setting falls back to HOMEOSTAT_DIR", async () => {
    const { findKb } = await import("../src/hook.ts");
    expect(findKb({ HOMEOSTAT_KB_DIR_SETTING: "", HOMEOSTAT_DIR: "/kb" }, "/x")).toBe("/kb");
    expect(
      findKb({ HOMEOSTAT_KB_DIR_SETTING: "${user_config.kb_dir}", HOMEOSTAT_DIR: "/kb" }, "/x"),
    ).toBe("/kb");
    expect(findKb({ HOMEOSTAT_KB_DIR_SETTING: "/set", HOMEOSTAT_DIR: "/kb" }, "/x")).toBe("/set");
    expect(findKb({ CLAUDE_PLUGIN_OPTION_KB_DIR: "/hook", HOMEOSTAT_DIR: "/kb" }, "/x")).toBe(
      "/hook",
    );
  });
});
