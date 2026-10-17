import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logEvent } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const HOOK = "https://hooks.slack.com/services/T000/B000/xyz";

/** The starter KB with a webhook configured, a flag this week and one guessed tool name. */
function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-digest-"));
  cpSync(starter, dir, { recursive: true });
  const config = join(dir, "homeostat.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      /notifications:\n(?: .*\n)*/,
      "notifications:\n  slackWebhookEnv: TEAM_SLACK_WEBHOOK\n",
    ),
  );
  const entry = join(dir, "knowledge/core/redact-before-logging.md");
  writeFileSync(
    entry,
    readFileSync(entry, "utf8").replace(
      "status: accepted",
      "status: accepted\nflags:\n  - by: lee\n    reason: misses the audit logger\n    date: 2026-10-13",
    ),
  );
  logEvent(dir, {
    ts: "2026-10-13T10:00:00Z",
    type: "mcp-alias",
    name: "get_rules",
    resolved: "context",
  });
  return dir;
}

async function digest(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const posted: { url: string; body: { text: string } }[] = [];
  const fetch = (async (url: string, init: { body: string }) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const code = await runCli(["node", "homeostat", "digest", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: { TEAM_SLACK_WEBHOOK: HOOK },
    now: () => new Date("2026-10-14T08:00:00Z"),
    fetch,
    ...extra,
  });
  return { code, stdout, stderr, posted };
}

describe("homeostat digest (K8)", () => {
  test("posts new rules, document updates, the review queue, flags and desire paths to the webhook", async () => {
    const { code, stdout, posted } = await digest(["--dir", kb(), "--days", "30"]);
    expect(code).toBe(0);
    expect(stdout).toContain("digest posted to Slack");
    expect(posted.map((p) => p.url)).toEqual([HOOK]);
    const text = posted[0]?.body.text ?? "";
    expect(text).toContain("*Homeostat digest, last 30 days* (since 2026-09-14)");
    expect(text).toContain("*New rules (2)*");
    expect(text).toContain("`integrations/partner-calls#http-client`");
    expect(text).toContain("*Waiting for review (1)*");
    expect(text).toContain("`redact-before-logging` by lee: misses the audit logger");
    expect(text).toContain("`get_rules` ×1");
  });

  test("--dry-run prints and posts nothing", async () => {
    const { stdout, posted } = await digest(["--dir", kb(), "--dry-run"]);
    expect(stdout).toContain("*Homeostat weekly digest*");
    expect(posted).toEqual([]);
  });

  test("a missing secret, or a URL that is not a Slack webhook, fails without posting", async () => {
    const missing = await digest(["--dir", kb()], { env: {} });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("set TEAM_SLACK_WEBHOOK");
    const wrong = await digest(["--dir", kb()], {
      env: { TEAM_SLACK_WEBHOOK: "https://evil.example/x" },
    });
    expect(wrong.code).toBe(1);
    expect(wrong.posted).toEqual([]);
  });

  test("a quiet week says so", async () => {
    const dir = kb();
    const candidate = join(dir, "knowledge/frontend/use-design-tokens-for-colors.md");
    writeFileSync(
      candidate,
      readFileSync(candidate, "utf8").replace("status: candidate", "status: retired"),
    );
    const { stdout } = await digest(["--dir", dir, "--dry-run", "--days", "1"], {
      now: () => new Date("2027-06-01T08:00:00Z"),
    });
    expect(stdout).toContain("A quiet week");
  });
});
