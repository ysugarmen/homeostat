import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

function setup() {
  const kbDir = mkdtempSync(join(tmpdir(), "homeostat-kb-"));
  cpSync(join(examples, "starter-kb"), kbDir, { recursive: true });
  const cwd = mkdtempSync(join(tmpdir(), "homeostat-code-"));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  return { kbDir, cwd };
}

async function prompt(kbDir: string, cwd: string, text: string, session = "s1") {
  // A real session starts first, which records what it was given and the KB view it saw.
  if (!started.has(`${kbDir}:${session}`)) {
    started.add(`${kbDir}:${session}`);
    await hook(kbDir, "session-start", { session_id: session, cwd, source: "startup" });
  }
  return JSON.parse(await hook(kbDir, "prompt", { session_id: session, cwd, prompt: text }))
    .hookSpecificOutput.additionalContext as string;
}

const started = new Set<string>();

async function hook(kbDir: string, event: string, input: object) {
  let stdout = "";
  const io: Io = {
    stdout: (s) => (stdout += s),
    stderr: () => {},
    color: false,
    env: { CLAUDE_PLUGIN_OPTION_KB_DIR: kbDir },
    stdin: async () => JSON.stringify(input),
    now: () => new Date("2026-10-13T12:00:00Z"),
  };
  expect(await runCli(["node", "homeostat", "hook", event], io)).toBe(0);
  return stdout;
}

describe("homeostat hook prompt: matching the message", () => {
  test("gives the rules whose words match a question that names no file, once per session", async () => {
    const { kbDir, cwd } = setup();
    const first = await prompt(
      kbDir,
      cwd,
      "How should I retry outbound HTTP calls to a partner API?",
    );
    expect(first).toContain("# Matching this message (homeostat)");
    expect(first).toMatch(/^## Use the shared retry helper .*\(outbound-http-retry-helper\)$/m);
    expect(first).toContain("Why: Partner APIs time out often.");
    expect(first).not.toContain("apply to the files in this session");

    const again = await prompt(
      kbDir,
      cwd,
      "How should I retry outbound HTTP calls to a partner API?",
    );
    expect(again).not.toContain("outbound-http-retry-helper");

    const elsewhere = await prompt(kbDir, cwd, "retry outbound HTTP calls partner API", "s2");
    expect(elsewhere).toContain("(outbound-http-retry-helper)");

    const events = readEvents(kbDir).filter((e) => e.type === "injection" && e.source === "prompt");
    expect(events).toHaveLength(2);
  });

  test("gives matching document sections with where to read them", async () => {
    const { kbDir, cwd } = setup();
    const text = await prompt(
      kbDir,
      cwd,
      "What timeouts does the shared HTTP client use for partner calls?",
    );
    expect(text).toMatch(/^## .+ \(integrations\/partner-calls#(timeouts|http-client)\)$/m);
    expect(readEvents(kbDir).some((e) => e.type === "doc-injection" && e.source === "prompt")).toBe(
      true,
    );
  });

  test("leaves short or unrelated messages alone", async () => {
    const { kbDir, cwd } = setup();
    expect(await prompt(kbDir, cwd, "yes, go")).not.toContain("Matching this message");
    expect(await prompt(kbDir, cwd, "Rename the variable foo to bar in the parser")).not.toContain(
      "Matching this message",
    );
  });
});
