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
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;
const NOW = new Date("2026-10-13T06:00:00Z");

/** The starter KB with sources, as a git repo on main with a bare origin. */
function kbRepo() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-cur-"));
  cpSync(join(examples, "starter-kb"), dir, { recursive: true });
  writeFileSync(
    join(dir, "homeostat.yaml"),
    `${readFileSync(join(dir, "homeostat.yaml"), "utf8").replace(/\n# Where the curator[\s\S]*$/, "")}
sources:
  host: github
  kbRepo: acme/team-kb
  repos: [acme/web-app]
`,
  );
  // A GitHub KB: its starter entry must point at a PR in a configured repo.
  const starterEntry = join(dir, "knowledge/integrations/outbound-http-retry-helper.md");
  writeFileSync(
    starterEntry,
    readFileSync(starterEntry, "utf8").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
      "https://github.com/acme/web-app/pull/812#discussion_r33",
    ),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  const origin = mkdtempSync(join(tmpdir(), "homeostat-origin-"));
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
const unused = (): never => {
  throw new Error("not used by this test");
};

class FakeProvider implements Provider {
  readonly kind = "github" as const;
  // `homeostat review` only; never reached here.
  getPullRequest = unused;
  getPullRequestDiff = unused;
  closePullRequest = unused;
  commentOnPullRequest = unused;
  opened: { repo: string; pr: NewPullRequest }[] = [];
  merged: number[] = [];
  mergeError?: Error;
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
  async mergePullRequest(_repo: RepoRef, id: number) {
    if (this.mergeError) throw this.mergeError;
    this.merged.push(id);
  }
}

/** Sets `scoring.autoMerge` in the KB's config. */
function autoMerge(dir: string, yaml: string) {
  const path = join(dir, "homeostat.yaml");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "  autoMergeThreshold: 3\n",
      `  autoMergeThreshold: 3\n  autoMerge:\n${yaml.replace(/^/gm, "    ")}\n`,
    ),
  );
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
  const code = await runCli(["node", "homeostat", "curate", ...args], io);
  return { code, stdout, stderr };
}

const PATH = "knowledge/frontend/use-colour-tokens-instead-of-hex-values.md";

describe("homeostat curate", () => {
  test("an entry that passes every gate is committed, pushed, opened and auto-merged", async () => {
    const { dir, git, origin } = kbRepo();
    const provider = new FakeProvider();
    const { code, stdout } = await run(["--dir", dir], provider);
    expect(code).toBe(0);
    expect(stdout).toContain("acme/web-app: 1 merged PR, 1 review thread");
    expect(stdout).toContain(`+ ${PATH} (accepted, score 4)`);

    expect(git("status", "--porcelain")).toBe("");
    const entry = git("show", `homeostat/curator-2026-10-13-auto:${PATH}`);
    expect(parseEntry(entry).entry?.frontmatter.source.author).toBe("sam");
    expect(
      execFileSync("git", ["-C", origin, "branch", "--list", "homeostat/curator-2026-10-13-auto"], {
        encoding: "utf8",
      }),
    ).toContain("homeostat/curator-2026-10-13-auto");

    expect(provider.opened).toHaveLength(1);
    const [opened] = provider.opened;
    expect(opened?.repo).toBe("acme/team-kb");
    expect(opened?.pr).toMatchObject({
      title: "homeostat: auto-merge 1 knowledge entry from review feedback",
      sourceBranch: "homeostat/curator-2026-10-13-auto",
      targetBranch: "main",
    });
    expect(opened?.pr.body).toContain("**Auto-merged.**");
    expect(opened?.pr.body).toContain(
      "| Use colour tokens instead of hex values | frontend | accepted | 4 |",
    );
    expect(opened?.pr.body).toContain("https://github.com/acme/web-app/pull/120#discussion_r9001");
    expect(stdout).toContain("opened https://github.com/acme/team-kb/pull/7");
    expect(provider.merged).toEqual([7]);
    expect(stdout).toContain("auto-merged https://github.com/acme/team-kb/pull/7");
  });

  test.each([
    ["excludeAreas: [frontend]", "area frontend always needs a reviewer"],
    ["areas: [integrations]", "area frontend is not in scoring.autoMerge.areas"],
    ["enabled: false", "auto-merge is off"],
  ])("with %s the entry goes to a review PR instead", async (yaml, reason) => {
    const { dir } = kbRepo();
    autoMerge(dir, yaml);
    const provider = new FakeProvider();
    const { code } = await run(["--dir", dir], provider);
    expect(code).toBe(0);
    expect(provider.merged).toEqual([]);
    expect(provider.opened).toHaveLength(1);
    expect(provider.opened[0]?.pr).toMatchObject({
      title: "homeostat: 1 knowledge entry from review feedback",
      sourceBranch: "homeostat/curator-2026-10-13",
    });
    expect(provider.opened[0]?.pr.body).toContain(reason);
  });

  test("maxPerRun caps how many entries auto-merge in one run", async () => {
    const { dir } = kbRepo();
    autoMerge(dir, "maxPerRun: 1");
    const provider = new FakeProvider();
    provider.listReviewComments = async () =>
      [9001, 9002].map((id) => ({
        id,
        body: `Comment ${id}`,
        author: { id: "sam" },
        createdAt: "2026-10-11T15:00:00Z",
        url: `https://github.com/acme/web-app/pull/120#discussion_r${id}`,
        path: "apps/web/src/Button.css",
        line: 4,
      }));
    await run(["--dir", dir], provider);
    expect(provider.opened.map((o) => o.pr.title)).toEqual([
      "homeostat: auto-merge 1 knowledge entry from review feedback",
      "homeostat: 1 knowledge entry from review feedback",
    ]);
    expect(provider.opened[1]?.pr.body).toContain("over the per-run cap (1)");
  });

  test("an entry that passes the gates is not merged if the knowledge base would not validate", async () => {
    const { dir, git } = kbRepo();
    // Break an existing entry on main; the auto PR would carry the breakage forward.
    const starterEntry = join(dir, "knowledge/integrations/outbound-http-retry-helper.md");
    writeFileSync(
      starterEntry,
      readFileSync(starterEntry, "utf8").replace("owner: dana", "owner: nobody"),
    );
    git("commit", "-qam", "break");
    const provider = new FakeProvider();
    const { stdout } = await run(["--dir", dir], provider);
    expect(provider.merged).toEqual([]);
    expect(stdout).toContain("not auto-merging https://github.com/acme/team-kb/pull/7");
  });

  test("when the host refuses the merge, the PR stays open for a reviewer", async () => {
    const { dir } = kbRepo();
    const provider = new FakeProvider();
    provider.mergeError = new Error("GitHub 405: Required status check is expected");
    const { code, stdout } = await run(["--dir", dir], provider);
    expect(code).toBe(0);
    expect(stdout).toContain("could not auto-merge https://github.com/acme/team-kb/pull/7");
    expect(stdout).toContain("it stays open for a reviewer");
  });

  test("--dry-run drafts and reports but writes nothing", async () => {
    const { dir, git } = kbRepo();
    const provider = new FakeProvider();
    const { code, stdout } = await run(["--dir", dir, "--dry-run"], provider);
    expect(code).toBe(0);
    expect(stdout).toContain(`+ ${PATH}`);
    expect(stdout).toContain("dry run: nothing committed");
    expect(git("branch", "--list")).not.toContain("homeostat/curator");
    expect(provider.opened).toEqual([]);
  });

  test("a second run the same day uses a new branch", async () => {
    const { dir, git } = kbRepo();
    git("branch", "homeostat/curator-2026-10-13-auto");
    await run(["--dir", dir], new FakeProvider());
    expect(git("branch", "--list", "homeostat/curator-2026-10-13-auto-2")).toContain(
      "homeostat/curator-2026-10-13-auto-2",
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
        title: "homeostat: candidates from lee",
        url: "u",
        author: { id: "lee" },
        sourceBranch: "candidates/lee",
        targetBranch: "main",
      },
    ];
    const { stdout } = await run(["--dir", dir], provider);
    const candidatePrs = provider.opened.filter((o) => o.pr.sourceBranch.startsWith("candidates/"));
    expect(candidatePrs.map((o) => o.pr.sourceBranch)).toEqual(["candidates/dana"]);
    expect(candidatePrs[0]?.pr.title).toBe("homeostat: candidates from dana");
    expect(stdout).toContain("candidates/lee already has a PR");
  });

  test("nothing new means no branch and no PR", async () => {
    const { dir, git } = kbRepo();
    const provider = new FakeProvider();
    provider.listMergedPullRequests = async () => [];
    const { code, stdout } = await run(["--dir", dir], provider);
    expect(code).toBe(0);
    expect(stdout).toContain("no new entries");
    expect(git("branch", "--list")).not.toContain("homeostat/curator");
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
    const code = await runCli(["node", "homeostat", "curate", "--dir", dir], {
      stdout: () => {},
      stderr: (s) => (stderr += s),
      color: false,
      env: {},
      drafter: new FakeDrafter(),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("set HOMEOSTAT_GIT_TOKEN or GITHUB_TOKEN");
  });
});
