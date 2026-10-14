import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Draft,
  type Drafter,
  type NewPullRequest,
  type Provider,
  type ReviewThread,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
// Built at runtime so the repo never contains the literal.
const TOKEN = ["ghp_", "Q".repeat(18), "w".repeat(18)].join("");

function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-sec-"));
  cpSync(starter, dir, { recursive: true });
  return dir;
}

async function run(args: string[], extra: Record<string, unknown> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: { GITHUB_TOKEN: "t" },
    now: () => new Date("2026-10-14T06:00:00Z"),
    ...extra,
  });
  return { code, stdout, stderr };
}

describe("a token in a review comment never reaches a prompt or the KB (T2)", () => {
  test("the curator redacts the thread before the model sees it", async () => {
    const dir = kb();
    const seen: ReviewThread[] = [];
    const drafter: Drafter = {
      async draft(t: ReviewThread): Promise<Draft | null> {
        seen.push(t);
        return null;
      },
    };
    const provider = {
      kind: "github",
      async listMergedPullRequests() {
        return [
          {
            id: 1,
            title: `Rotate ${TOKEN}`,
            url: "u",
            author: { id: "lee" },
            mergedAt: "2026-10-13T00:00:00Z",
            sourceBranch: "f",
            targetBranch: "main",
          },
        ];
      },
      async listOpenPullRequests() {
        return [];
      },
      async listReviewComments() {
        return [
          {
            id: 9,
            body: `Never paste tokens like ${TOKEN} into the config`,
            author: { id: "sam" },
            createdAt: "2026-10-12T00:00:00Z",
            url: "https://github.com/acme/web-app/pull/1#discussion_r9",
            path: "a.ts",
          },
        ];
      },
      async listCommits() {
        return [{ sha: "a", date: "2026-10-12T01:00:00Z", message: "fix" }];
      },
      async openPullRequest(_: unknown, pr: NewPullRequest) {
        return { id: 1, url: pr.title };
      },
    } as unknown as Provider;
    const { stdout } = await run(["curate", "--dir", dir, "--dry-run"], { provider, drafter });
    expect(seen).toHaveLength(2); // one per configured source repo
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(seen[0]?.root.body).toContain("[REDACTED:github-token]");
    expect(stdout).toContain("redacted 4 secret(s) from review threads before drafting");
  });

  test("learn refuses an entry that contains a secret, and writes nothing", async () => {
    const dir = kb();
    const { code, stdout } = await run([
      "learn",
      "--dir",
      dir,
      "--id",
      "leak",
      "--author",
      "lee",
      "--title",
      "Use the deploy token",
      "--rule",
      `Deploy with ${TOKEN} from CI.`,
      "--why",
      "It works.",
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("possible github-token");
    expect(existsSync(join(dir, "knowledge/core/leak.md"))).toBe(false);
  });

  test("flag refuses a reason that contains a secret", async () => {
    const dir = kb();
    const before = readFileSync(join(dir, "knowledge/core/redact-before-logging.md"), "utf8");
    const { code, stderr } = await run([
      "flag",
      "redact-before-logging",
      "--dir",
      dir,
      "--by",
      "lee",
      "--reason",
      `wrong, use ${TOKEN}`,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("contains a possible github-token");
    expect(readFileSync(join(dir, "knowledge/core/redact-before-logging.md"), "utf8")).toBe(before);
  });

  test("validate fails a committed entry with a secret and warns on emails", async () => {
    const dir = kb();
    const path = join(dir, "knowledge/core/redact-before-logging.md");
    const text = readFileSync(path, "utf8").replace(
      "## Why\n",
      `## Why\nAsk dana@example.com. Key: ${TOKEN}\n`,
    );
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, text);
    const { code, stdout } = await run(["validate", dir]);
    expect(code).toBe(1);
    expect(stdout).toContain("possible github-token (ghp_…) on line");
    expect(stdout).toContain("email address dana@example.com: refer to people by member id");
    expect(stdout).not.toContain(TOKEN);
  });
});
