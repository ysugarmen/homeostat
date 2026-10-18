import type { OpenPullRequest, Provider, PullRequestDetails } from "@homeostat/core";
import { ProviderError } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

/** The starter KB: Bitbucket host, KB repo acme/team-kb, base branch main. */
const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

const row = (decision: string, title: string) => `| ${decision} | ${title} (\`x\`) | 55 | | why |`;

function pr(
  id: number,
  branch: string,
  extra: Partial<PullRequestDetails> = {},
): PullRequestDetails {
  return {
    id,
    title: `homeostat: lessons · ${id}`,
    url: `https://bitbucket.org/acme/team-kb/pull-requests/${id}`,
    author: { id: "homeostat-bot" },
    sourceBranch: branch,
    targetBranch: "main",
    body: [row("review", "One"), row("review", "Two")].join("\n"),
    state: "open",
    createdAt: `2026-10-${10 + id}T06:00:00Z`,
    reviewers: [],
    conflicts: false,
    ...extra,
  };
}

/** A host holding these PRs; records every write. */
function host(prs: PullRequestDetails[], opts: { refuseMerge?: string } = {}) {
  const writes: string[] = [];
  const find = (id: number) => {
    const found = prs.find((p) => p.id === id);
    if (!found) throw new ProviderError("Bitbucket", 404, `pullrequests/${id}`, "not found");
    return found;
  };
  const provider = {
    kind: "bitbucket",
    listOpenPullRequests: async (): Promise<OpenPullRequest[]> =>
      prs.filter((p) => p.state === "open"),
    getPullRequest: async (_repo: unknown, id: number) => find(id),
    getPullRequestDiff: async () => "diff --git a/knowledge/core/one.md b/knowledge/core/one.md\n",
    mergePullRequest: async (_repo: unknown, id: number) => {
      if (opts.refuseMerge)
        throw new ProviderError("Bitbucket", 400, `pullrequests/${id}/merge`, opts.refuseMerge);
      writes.push(`merge ${id}`);
    },
    closePullRequest: async (_repo: unknown, id: number) => {
      writes.push(`close ${id}`);
    },
    commentOnPullRequest: async (_repo: unknown, id: number, text: string) => {
      writes.push(`comment ${id}: ${text}`);
    },
  } as unknown as Provider;
  return { provider, writes };
}

async function review(provider: Provider, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = { provider };
  const code = await runCli(["node", "homeostat", "review", ...args, "--dir", starter], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    ...io,
  });
  return { code, stdout, stderr };
}

describe("homeostat review list", () => {
  test("lists only homeostat's PRs into the base branch, oldest first", async () => {
    const { provider } = host([
      pr(3, "homeostat/review-lee-2026-10-15"),
      pr(1, "homeostat/daily-sam-2026-10-14", { body: row("merged", "Three") }),
      pr(2, "feature/unrelated"),
      pr(4, "homeostat/review-kim-2026-10-15", { targetBranch: "release" }),
      pr(5, "homeostat/review-ada-2026-10-16", { state: "merged" }),
    ]);
    const { code, stdout } = await review(provider, "list");
    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        "2 PRs with 3 lessons to review:",
        "  #1 lessons · 1 (1 lesson) · the host refused to merge this daily PR",
        "     https://bitbucket.org/acme/team-kb/pull-requests/1",
        "  #3 lessons · 3 (2 lessons)",
        "     https://bitbucket.org/acme/team-kb/pull-requests/3",
        "",
      ].join("\n"),
    );
  });

  test("puts the PRs that ask the reviewer first, and flags conflicts", async () => {
    const { provider } = host([
      pr(1, "homeostat/review-lee-2026-10-14", { conflicts: true }),
      pr(2, "homeostat/review-sam-2026-10-15", { reviewers: [{ id: "Dana" }] }),
    ]);
    const { stdout } = await review(provider, "list", "--reviewer", "@dana");
    expect(stdout).toContain("  #2 lessons · 2 (2 lessons) · asks @Dana\n");
    expect(stdout.indexOf("#2")).toBeLessThan(stdout.indexOf("#1"));
    expect(stdout).toContain("#1 lessons · 1 (2 lessons) · conflicts with main");
  });

  test("--json gives the skill what it needs to sort and filter", async () => {
    const { provider } = host([pr(1, "homeostat/review-lee-2026-10-14")]);
    const { stdout } = await review(provider, "list", "--json");
    expect(JSON.parse(stdout)).toEqual([
      {
        id: 1,
        title: "lessons · 1",
        url: "https://bitbucket.org/acme/team-kb/pull-requests/1",
        kind: "review",
        member: "lee",
        date: "2026-10-14",
        lessons: 2,
        reviewers: [],
        createdAt: "2026-10-11T06:00:00Z",
        conflicts: false,
      },
    ]);
  });

  test("an empty queue says so", async () => {
    const { stdout } = await review(host([]).provider, "list");
    expect(stdout).toBe("nothing to review: no homeostat PR is waiting\n");
  });
});

describe("homeostat review show", () => {
  test("prints the lessons table, whether it merges, and the diff", async () => {
    const { provider } = host([pr(7, "homeostat/review-lee-2026-10-14", { conflicts: true })]);
    const { code, stdout } = await review(provider, "show", "#7");
    expect(code).toBe(0);
    expect(stdout).toContain("homeostat/review-lee-2026-10-14 into main · conflicts with main");
    expect(stdout).toContain(row("review", "One"));
    expect(stdout).toContain("diff --git a/knowledge/core/one.md");
  });
});

describe("homeostat review merge", () => {
  test("merges a review PR, taking its URL", async () => {
    const { provider, writes } = host([pr(7, "homeostat/review-lee-2026-10-14")]);
    const { code, stdout } = await review(
      provider,
      "merge",
      "https://bitbucket.org/acme/team-kb/pull-requests/7",
    );
    expect(code).toBe(0);
    expect(writes).toEqual(["merge 7"]);
    expect(stdout).toContain("merged #7: its 2 lessons are accepted");
  });

  test("a conflicting PR is not merged; it says how to resolve it", async () => {
    const { provider, writes } = host([
      pr(9, "homeostat/review-dana-2026-10-14", { conflicts: true }),
    ]);
    const { code, stderr } = await review(provider, "merge", "9");
    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(stderr).toContain("#9 conflicts with main");
    expect(stderr).toContain("git switch homeostat/review-dana-2026-10-14");
    expect(stderr).toContain('homeostat review close 9 --reason "already on main"');
  });

  test("a refusal from the host is reported with what to do", async () => {
    const { provider } = host([pr(7, "homeostat/review-lee-2026-10-14")], {
      refuseMerge: "You need 1 approval",
    });
    const { code, stderr } = await review(provider, "merge", "7");
    expect(code).toBe(1);
    expect(stderr).toContain("the host refused to merge #7: You need 1 approval");
    expect(stderr).toContain("give it on the PR");
  });

  test("never touches a PR that is not homeostat's, or one already decided", async () => {
    const { provider, writes } = host([
      pr(2, "feature/unrelated"),
      pr(5, "homeostat/review-ada-2026-10-16", { state: "merged" }),
    ]);
    const other = await review(provider, "merge", "2");
    expect(other.code).toBe(1);
    expect(other.stderr).toContain("#2 is not one of homeostat's PRs");
    const done = await review(provider, "close", "5", "--reason", "x");
    expect(done.stderr).toContain("#5 is already merged");
    expect(writes).toEqual([]);
  });

  test("an unknown PR is an error, not a crash", async () => {
    const { code, stderr } = await review(host([]).provider, "merge", "99");
    expect(code).toBe(1);
    expect(stderr).toContain("404");
  });
});

describe("homeostat review close and comment", () => {
  test("close posts the reason, then closes", async () => {
    const { provider, writes } = host([pr(7, "homeostat/review-lee-2026-10-14")]);
    const { code, stdout } = await review(provider, "close", "7", "--reason", "duplicate of x");
    expect(code).toBe(0);
    expect(writes).toEqual(["comment 7: Declined in review: duplicate of x", "close 7"]);
    expect(stdout).toContain("closed #7: its 2 lessons are declined (duplicate of x)");
  });

  test("close needs a reason", async () => {
    const { provider, writes } = host([pr(7, "homeostat/review-lee-2026-10-14")]);
    const { code } = await review(provider, "close", "7");
    expect(code).toBe(1);
    expect(writes).toEqual([]);
  });

  test("comment asks the author and leaves the PR open", async () => {
    const { provider, writes } = host([pr(7, "homeostat/review-lee-2026-10-14")]);
    const { code } = await review(provider, "comment", "7", "Which", "client?");
    expect(code).toBe(0);
    expect(writes).toEqual(["comment 7: Which client?"]);
  });
});
