import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateCodeowners, parseConfig, score } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-pending-"));
  cpSync(starter, dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
  return dir;
}

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-16T09:00:00Z"),
    ...extra,
  });
  return { code, stdout, stderr };
}

async function session(kbDir: string, file: string) {
  const cwd = mkdtempSync(join(tmpdir(), "homeostat-pending-code-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), "x");
  const { stdout } = await run(["hook", "session-start"], {
    env: { HOMEOSTAT_DIR: kbDir },
    stdin: async () => JSON.stringify({ session_id: "s", cwd }),
  });
  return stdout ? (JSON.parse(stdout).hookSpecificOutput.additionalContext as string) : "";
}

describe("pending lessons (automation, step 1)", () => {
  test("a lesson applies to its author's sessions at once, and the tracked files stay clean", async () => {
    const dir = kb();
    const before = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });
    const r = await run([
      "learn",
      "--dir",
      dir,
      "--author",
      "lee",
      "--area",
      "frontend",
      "--title",
      "Use the shared button component",
      "--rule",
      "Render buttons with <Button> from apps/web/ui, never a raw button tag.",
      "--why",
      "Raw buttons skip the focus ring and the analytics hook.",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(dir, "knowledge/frontend/use-the-shared-button-component.md"))).toBe(
      false,
    );
    expect(
      existsSync(
        join(dir, ".homeostat/pending/knowledge/frontend/use-the-shared-button-component.md"),
      ),
    ).toBe(true);
    // .homeostat/ is git-ignored, so git sees nothing new.
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe(
      before,
    );
    expect(await session(dir, "apps/web/src/App.tsx")).toContain("use-the-shared-button-component");
  });

  test("a flag disputes the rule in its author's sessions at once", async () => {
    const dir = kb();
    expect(await session(dir, "services/api/x.ts")).toContain("redact-before-logging");
    await run([
      "flag",
      "redact-before-logging",
      "--dir",
      dir,
      "--by",
      "lee",
      "--reason",
      "renamed to scrub()",
    ]);
    expect(await session(dir, "services/api/x.ts")).not.toContain("redact-before-logging");
    expect(
      readFileSync(join(dir, "knowledge/core/redact-before-logging.md"), "utf8"),
    ).not.toContain("flags:");
  });

  test("status reports a pending copy under another file name as a duplicate id", async () => {
    const dir = kb();
    await run([
      "learn",
      "--dir",
      dir,
      "--author",
      "dana",
      "--area",
      "integrations",
      "--title",
      "Use the shared retry helper for partner calls",
      "--rule",
      "Wrap every partner API call in withRetry() from services/integrations/http.ts.",
      "--why",
      "Partner APIs time out; hand-rolled retries skipped the request-id header.",
    ]);
    const pending = join(dir, ".homeostat/pending/knowledge/integrations");
    const text = readFileSync(
      join(pending, "use-the-shared-retry-helper-for-partner-calls.md"),
      "utf8",
    );
    writeFileSync(join(pending, "retry.md"), text);
    const { stdout } = await run(["status", "--dir", dir]);
    expect(stdout).toMatch(/- Problems: \d+, including pending lessons/);
    expect(stdout).toContain("knowledge/integrations/retry.md");
  });

  test("learn shows warnings after saving, and validate checks pending lessons", async () => {
    const dir = kb();
    const saved = await run([
      "learn",
      "--dir",
      dir,
      "--author",
      "dana",
      "--area",
      "integrations",
      "--title",
      "Ask about partner keys",
      "--rule",
      "Ask dana@example.com before rotating partner keys.",
      "--why",
      "She owns the vault.",
    ]);
    expect(saved.code).toBe(0);
    expect(saved.stdout).toContain("saved ask-about-partner-keys");
    expect(saved.stdout).toMatch(/warning.*email/i);
    const checked = await run(["validate", dir]);
    expect(checked.stdout).toMatch(/warning.*email/i);
    expect(checked.stdout).toContain("(including 1 pending lesson from .homeostat/pending");
  });

  test("flagging your own pending lesson takes it out of your sessions", async () => {
    const dir = kb();
    await run([
      "learn",
      "--dir",
      dir,
      "--author",
      "dana",
      "--area",
      "integrations",
      "--title",
      "Use the shared retry helper for partner calls",
      "--rule",
      "Wrap every partner API call in withRetry() from services/integrations/http.ts.",
      "--why",
      "Partner APIs time out; hand-rolled retries skipped the request-id header.",
    ]);
    const id = "use-the-shared-retry-helper-for-partner-calls";
    expect(await session(dir, "services/integrations/a.ts")).toContain(id);
    const flagged = await run(["flag", id, "--dir", dir, "--by", "lee", "--reason", "it moved"]);
    expect(flagged.stdout).toContain("it no longer applies to your sessions");
    const explained = await run(["explain", "--dir", dir, id]);
    expect(explained.stdout).toContain(
      "Pending in this clone, flagged: it is out of your sessions",
    );
    expect(await session(dir, "services/integrations/a.ts")).not.toContain(id);
  });
});

describe("roles", () => {
  const config = (role: string) =>
    parseConfig(
      `version: 1\nteam:\n  members:\n    - { id: dana, role: ${role}, handle: "@dana" }\nareas: {}\n`,
    ).config;

  test("junior and lead are valid; a lead counts as senior", () => {
    const lead = config("lead");
    const junior = config("junior");
    if (!lead || !junior) throw new Error("roles should parse");
    const fm = {
      source: { type: "manual", author: "dana" },
      flags: [],
      conflictsWith: [],
    } as never;
    expect(score(fm, { config: lead }).score).toBe(3);
    expect(score(fm, { config: junior }).score).toBe(2);
    expect(generateCodeowners(lead, []).text).toMatch(/^\/homeostat\.yaml\s+@dana$/m);
  });

  test("search finds a lesson saved a minute ago; explain says it is pending", async () => {
    const dir = kb();
    await run([
      "learn",
      "--dir",
      dir,
      "--author",
      "dana",
      "--area",
      "integrations",
      "--title",
      "Use the shared retry helper for partner calls",
      "--rule",
      "Wrap every partner API call in withRetry() from services/integrations/http.ts.",
      "--why",
      "Partner APIs time out; hand-rolled retries skipped the request-id header.",
    ]);
    const found = await run(["search", "--dir", dir, "retry", "partner"]);
    expect(found.stdout).toContain("use-the-shared-retry-helper-for-partner-calls");
    const explained = await run([
      "explain",
      "--dir",
      dir,
      "use-the-shared-retry-helper-for-partner-calls",
    ]);
    expect(explained.stdout).toContain("Status: candidate");
    expect(explained.stdout).toContain("Pending in this clone: it applies to your sessions now");
  });
});
