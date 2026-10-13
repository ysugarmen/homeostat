import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname;
const launcher = join(repo, "packages/plugin/hooks/run.mjs");

// The full path the plugin uses: plain Node runs the launcher, which runs the real kbx bin.
test("the plugin's hook launcher runs kbx and passes the event JSON through", () => {
  const kb = mkdtempSync(join(tmpdir(), "kbx-launch-"));
  cpSync(join(repo, "examples/starter-kb"), kb, { recursive: true });
  const out = execFileSync(process.execPath, [launcher, "session-start"], {
    input: JSON.stringify({ session_id: "l1", cwd: kb, source: "startup" }),
    env: { ...process.env, KBX_CLI: join(repo, "packages/cli/bin/kbx.js"), KBX_DIR: kb },
    encoding: "utf8",
  });
  const context = JSON.parse(out).hookSpecificOutput.additionalContext;
  expect(context).toContain("(redact-before-logging)");
});

test("the launcher exits 0 even when kbx fails", () => {
  const out = execFileSync(process.execPath, [launcher, "no-such-event"], {
    input: "{}",
    env: { ...process.env, KBX_CLI: join(repo, "packages/cli/bin/kbx.js") },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  expect(out).toBe("");
});
