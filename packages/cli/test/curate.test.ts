import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Draft,
  type Drafter,
  type NewPullRequest,
  type OpenPullRequest,
  type Provider,
  type PullRequest,
  parseEntry,
  type RepoRef,
  type ReviewThread,
} from "@kbx/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;
const NOW = new Date("2026-10-13T06:00:00Z");

/** The starter KB with sources, as a git repo on main with a bare origin. */
function kbRepo() {
  const dir = mkdtempSync(join(tmpdir(), "kbx-cur-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  writeFileSync(
    join(dir, "kbx.yaml"),
    `${readFileSync(join(dir, "kbx.yaml"), "utf8").replace(/\n# Where the curator[\s\S]*$/, "")}
sources:
  host: github
  kbRepo: acme/team-kb
  repos: [acme/web-app]
`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const origin = mkdtempSync(join(tmpdir(), "kbx-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "ci");
  git("config", "user.email", "ci@example.com");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  return { dir, git, origin };
}

/** A provider with one merged PR whose reviewer feedback was acted on. */
class FakeProvider implements Provider {
  readonly kind = "github" as const;
  opened: { repo: string; pr: NewPullRequest }[] = [];
  open: OpenPullRequest[] = [];
  async listMergedPullRequests(_repo: RepoRef, _since: Date): Promise<PullRequest[]> {
    return [
      {
        id: 120,
        title: "Booking widget styles",
        url: "https://github.com/acme/web-app/pull/120",
        author: { id: "lee" },
        mergedAt: "2026-10-12T10:00:00Z",
        sourceBranch: "f",
        targetBranch: "main",
      },
    ];
  }
  async listOpenPullRequests() {
    return this.open;
  }
  async listReviewComments() {
    return [
      {
        id: 9001,
        body: "Use var(--color-primary) instead of the hex value; it breaks dark mode.",
        author: { id: "sam" },
        createdAt: "2026-10-11T15:00:00Z",
        url: "https://github.com/acme/web-app/pull/120#discussion_r9001",
        path: "apps/web/src/Button.css",
        line: 4,
      },
    ];
  }
  async listCommits() {
    return [{ sha: "a", date: "2026-10-11T16:00:00Z", message: "use tokens" }];
  }
  async openPullRequest(repo: { owner: string; name: string }, pr: NewPullRequest) {
    this.opened.push({ repo: `${repo.owner}/${repo.name}`, pr });
    return { id: 7, url: "https://github.com/acme/team-kb/pull/7" };
  }
}

class FakeDrafter implements Drafter {
  async draft(_t: ReviewThread): Promise<Draft> {
    return {
      title: "Use colour tokens instead of hex values",
      rule: "Reference colours through var(--color-*) tokens in component styles, never hex values.",
      why: "Hex values do not change with the theme, which broke dark mode.",
      area: "frontend",
    };
  }
}

async function run(args: string[], provider: Provider, env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: { GITHUB_TOKEN: "t", ...env },
    now: () => NOW,
    provider,
    drafter: new FakeDrafter(),
  };
  const code = await runCli(["node", "kbx", "curate", ...args], io);
  return { code, stdout, stderr };
}

const PATH = "knowledge/frontend/use-colour-tokens-instead-of-hex-values.md";

describe("kbx curate", () => {
  test("commits drafted entries to a dated branch, pushes it and opens one PR", async () => {
    const { dir, git, origin } = kbRepo();
    const provider = new FakeProvider();
    const { code, stdout } = await run(["--dir", dir], provider);
    expect(code).toBe(0);
    expect(stdout).toContain("acme/web-app: 1 merged PR, 1 review thread");
    expect(stdout).toContain(`+ ${PATH} (accepted, score 4)`);

    expect(git("status", "--porcelain")).toBe("");
    const entry = git("show", `kbx/curator-2026-10-13:${PATH}`);
    expect(parseEntry(entry).entry?.frontmatter.source.author).toBe("sam");
    expect(
      execFileSync("git", ["-C", origin, "branch", "--list", "kbx/curator-2026-10-13"], {
        encoding: "utf8",
      }),
    ).toContain("kbx/curator-2026-10-13");

    expect(provider.opened).toHaveLength(1);
    const [opened] = provider.opened;
    expect(opened?.repo).toBe("acme/team-kb");
    expect(opened?.pr).toMatchObject({
      title: "kbx: 1 knowledge entry from review feedback",
      sourceBranch: "kbx/curator-2026-10-13",
      targetBranch: "main",
    });
    expect(opened?.pr.body).toContain(
      "| Use colour tokens instead of hex values | frontend | accepted | 4 |",
    );
    expect(opened?.pr.body).toContain("https://github.com/acme/web-app/pull/120#discussion_r9001");
    expect(stdout).toContain("opened https://github.com/acme/team-kb/pull/7");
  });

  test("--dry-run drafts and reports but writes nothing", async () => {
    const { dir, git } = kbRepo();
    const provider = new FakeProvider();
    const { code, stdout } = await run(["--dir", dir, "--dry-run"], provider);
    expect(code).toBe(0);
    expect(stdout).toContain(`+ ${PATH}`);
    expect(stdout).toContain("dry run: nothing committed");
    expect(git("branch", "--list")).not.toContain("kbx/curator");
    expect(provider.opened).toEqual([]);
  });

  test("a second run the same day uses a new branch", async () => {
    const { dir, git } = kbRepo();
    git("branch", "kbx/curator-2026-10-13");
    await run(["--dir", dir], new FakeProvider());
    expect(git("branch", "--list", "kbx/curator-2026-10-13-2")).toContain(
      "kbx/curator-2026-10-13-2",
    );
  });

  test("candidate branches ahead of base get a PR unless they already have one", async () => {
    const { dir, git } = kbRepo();
    for (const member of ["lee", "dana"]) {
      git("checkout", "-qb", `candidates/${member}`, "main");
      writeFileSync(join(dir, `${member}.txt`), member);
      git("add", "-A");
      git("commit", "-qm", `note from ${member}`);
      git("push", "-q", "origin", `candidates/${member}`);
    }
    git("checkout", "-q", "main");
    const provider = new FakeProvider();
    provider.open = [
      {
        id: 40,
        title: "kbx: candidates from lee",
        url: "u",
        author: { id: "lee" },
        sourceBranch: "candidates/lee",
        targetBranch: "main",
      },
    ];
    const { stdout } = await run(["--dir", dir], provider);
    const candidatePrs = provider.opened.filter((o) => o.pr.sourceBranch.startsWith("candidates/"));
    expect(candidatePrs.map((o) => o.pr.sourceBranch)).toEqual(["candidates/dana"]);
    expect(candidatePrs[0]?.pr.title).toBe("kbx: candidates from dana");
    expect(stdout).toContain("candidates/lee already has a PR");
  });

  test("nothing new means no branch and no PR", async () => {
    const { dir, git } = kbRepo();
    const provider = new FakeProvider();
    provider.listMergedPullRequests = async () => [];
    const { code, stdout } = await run(["--dir", dir], provider);
    expect(code).toBe(0);
    expect(stdout).toContain("no new entries");
    expect(git("branch", "--list")).not.toContain("kbx/curator");
  });

  test("--since overrides the lookback window", async () => {
    const { dir } = kbRepo();
    const provider = new FakeProvider();
    let since: Date | undefined;
    provider.listMergedPullRequests = async (_r, s) => {
      since = s;
      return [];
    };
    await run(["--dir", dir, "--since", "2026-10-01"], provider);
    expect(since?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    await run(["--dir", dir], provider);
    expect(since?.toISOString()).toBe("2026-10-12T04:00:00.000Z");
  });

  test("a missing token says which variable to set", async () => {
    const { dir } = kbRepo();
    let stderr = "";
    const code = await runCli(["node", "kbx", "curate", "--dir", dir], {
      stdout: () => {},
      stderr: (s) => (stderr += s),
      color: false,
      env: {},
      drafter: new FakeDrafter(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("set KBX_GITHUB_TOKEN or GITHUB_TOKEN");
  });
});
