import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConflictJudge,
  countTokens,
  type Entry,
  type Frontmatter,
  formatEntry,
  type Merger,
  type NewPullRequest,
  type Provider,
  parseEntry,
  type Retractor,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;
const DUP = "knowledge/integrations/retry-helper-for-all-outbound-http.md";
const KEEP = "knowledge/integrations/outbound-http-retry-helper.md";

/** The starter KB plus a seeded near-duplicate, as a git repo with a bare origin. */
function kbRepo() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-dd-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  writeFileSync(
    join(dir, "homeostat.yaml"),
    readFileSync(join(dir, "homeostat.yaml"), "utf8").replace("host: bitbucket", "host: github"),
  );
  writeFileSync(
    join(dir, KEEP),
    readFileSync(join(dir, KEEP), "utf8").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
      "https://github.com/acme/integrations-api/pull/812#discussion_r33",
    ),
  );
  const body =
    "## Rule\nEvery outbound HTTP call goes through withRetry().\n\n## Why\nHand-rolled retries skipped the request-id header.";
  const fm: Frontmatter = {
    id: "retry-helper-for-all-outbound-http",
    title: "Use the shared retry helper for all outbound HTTP calls",
    area: "integrations",
    scope: ["services/integrations/**"],
    status: "accepted",
    score: 3,
    owner: "dana",
    source: { type: "manual", author: "dana" },
    created: "2026-10-10",
    lastConfirmed: "2026-10-10",
    tokens: countTokens(body),
  };
  writeFileSync(join(dir, DUP), formatEntry(fm, body));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const origin = mkdtempSync(join(tmpdir(), "homeostat-dd-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "ci");
  git("config", "user.email", "ci@example.com");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  return { dir, git };
}

class RecordingProvider {
  readonly kind = "github" as const;
  opened: NewPullRequest[] = [];
  async openPullRequest(_repo: unknown, pr: NewPullRequest) {
    this.opened.push(pr);
    return { id: 8, url: "https://github.com/acme/team-kb/pull/8" };
  }
}

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const provider = new RecordingProvider();
  const code = await runCli(["node", "homeostat", "deep-dive", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: { GITHUB_TOKEN: "t" },
    now: () => new Date("2026-10-13T07:00:00Z"),
    provider: provider as unknown as Provider,
    ...extra,
  });
  return { code, stdout, stderr, provider };
}

describe("homeostat deep-dive", () => {
  test("--no-llm merges the seeded duplicates on a branch and opens one PR", async () => {
    const { dir, git } = kbRepo();
    const { code, stdout, provider } = await run(["--dir", dir, "--no-llm"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`${KEEP}: merged (absorbed retry-helper-for-all-outbound-http)`);
    expect(stdout).toContain(`${DUP}: retired-duplicate (merged into outbound-http-retry-helper)`);

    const branch = "homeostat/deep-dive-2026-10-13";
    expect(parseEntry(git("show", `${branch}:${DUP}`)).entry?.frontmatter.status).toBe("retired");
    expect(parseEntry(git("show", `${branch}:${KEEP}`)).entry?.frontmatter.supersedes).toBe(
      "retry-helper-for-all-outbound-http",
    );
    expect(git("status", "--porcelain")).toBe("");

    expect(provider.opened).toHaveLength(1);
    expect(provider.opened[0]?.title).toBe("homeostat: weekly deep dive (2 entries changed)");
    expect(provider.opened[0]?.body).toContain(
      "| outbound-http-retry-helper | merged | absorbed retry-helper-for-all-outbound-http |",
    );
  });

  test("uses the injected merger and judge when not --no-llm", async () => {
    const { dir } = kbRepo();
    let merged = 0;
    let judged = 0;
    const merger: Merger = {
      merge: async (keep: Entry) => {
        merged++;
        return { title: keep.frontmatter.title, rule: "Merged rule.", why: "Merged why." };
      },
    };
    const judge: ConflictJudge = {
      conflicts: async () => {
        judged++;
        return [];
      },
    };
    await run(["--dir", dir, "--dry-run"], { merger, judge });
    expect(merged).toBe(1);
    expect(judged).toBeGreaterThan(0);
  });

  test("a stale rule's citing document section is retracted in the same PR; --dry-run prints it", async () => {
    const { dir, git } = kbRepo();
    const DOC = "knowledge/integrations/docs/partner-calls.md";
    writeFileSync(
      join(dir, KEEP),
      readFileSync(join(dir, KEEP), "utf8").replace(
        "lastConfirmed: 2026-10-07",
        "lastConfirmed: 2026-03-01",
      ),
    );
    writeFileSync(
      join(dir, DOC),
      readFileSync(join(dir, DOC), "utf8").replace(
        "that partner support asks for.",
        "that partner support asks for. Never use axios-retry (outbound-http-retry-helper).",
      ),
    );
    git("commit", "-qam", "stale and cited");
    git("push", "-q", "origin", "main");
    const asked: string[] = [];
    const retractor: Retractor = {
      retract: async (i) => {
        asked.push(`${i.section.id}:${i.retired.id}`);
        return {
          change: true,
          body: i.section.body.replace(" Never use axios-retry (outbound-http-retry-helper).", ""),
          reason: "the axios-retry ban came from the stale rule",
        };
      },
    };
    const merger: Merger = {
      merge: async (keep: Entry) => ({
        title: keep.frontmatter.title,
        rule: keep.sections.rule ?? "",
        why: keep.sections.why ?? "",
      }),
    };
    const judge: ConflictJudge = { conflicts: async () => [] };
    const dry = await run(["--dir", dir, "--dry-run"], { retractor, merger, judge });
    expect(asked).toEqual(["http-client:outbound-http-retry-helper"]);
    expect(dry.stdout).toContain(
      `${DOC}: retracted (#http-client no longer states the retired outbound-http-retry-helper: the axios-retry ban came from the stale rule)`,
    );
    expect(dry.provider.opened).toEqual([]);

    const { provider } = await run(["--dir", dir], { retractor, merger, judge });
    const branch = "homeostat/deep-dive-2026-10-13";
    expect(parseEntry(git("show", `${branch}:${KEEP}`)).entry?.frontmatter.status).toBe("retired");
    const doc = git("show", `${branch}:${DOC}`);
    expect(doc).not.toContain("axios-retry");
    expect(doc).toContain("source=deep-dive");
    expect(provider.opened[0]?.body).toContain(`| ${DOC} | retracted | #http-client`);
  });

  test("--dry-run reports without committing", async () => {
    const { dir, git } = kbRepo();
    const { stdout, provider } = await run(["--dir", dir, "--no-llm", "--dry-run"]);
    expect(stdout).toContain("dry run: nothing committed");
    expect(git("branch", "--list")).not.toContain("deep-dive");
    expect(provider.opened).toEqual([]);
  });

  test("nothing to do is said plainly", async () => {
    const { dir, git } = kbRepo();
    git("rm", "-q", DUP);
    git("commit", "-qm", "drop dup");
    const { code, stdout } = await run(["--dir", dir, "--no-llm"]);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to change");
  });
});
