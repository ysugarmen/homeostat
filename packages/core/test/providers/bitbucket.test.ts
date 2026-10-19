import { describe, expect, test } from "vitest";
import { BitbucketProvider } from "../../src/providers/bitbucket.ts";
import { ProviderError } from "../../src/providers/http.ts";
import { replayFetch } from "./replay.ts";

const repo = { owner: "acme", name: "integrations-api" };
const since = new Date("2026-10-06T00:00:00Z");

function provider() {
  const replay = replayFetch("bitbucket");
  return { ...replay, bb: new BitbucketProvider({ token: "test-token", fetch: replay.fetch }) };
}

describe("BitbucketProvider", () => {
  test("lists merged PRs across pages, newest first", async () => {
    const { bb, sent } = provider();
    const prs = await bb.listMergedPullRequests(repo, since);
    expect(prs.map((p) => p.id)).toEqual([815, 812, 801]);
    expect(prs[1]).toEqual({
      id: 812,
      title: "Retry partner calls through the http client",
      url: "https://bitbucket.org/acme/integrations-api/pull-requests/812",
      author: { id: "sam", name: "Sam Ortiz" },
      mergedAt: "2026-10-07T10:20:30.000000+00:00",
      sourceBranch: "feature/partner-retry",
      targetBranch: "main",
    });
    expect(sent).toHaveLength(2);
  });

  test("authenticates with a bearer token", async () => {
    const { bb, sent } = provider();
    await bb.listCommits(repo, 812);
    expect(sent[0]?.headers.Authorization).toBe("Bearer test-token");
  });

  test("with an account email, sends an API token as Basic auth", async () => {
    // Atlassian API tokens are Basic auth (email:token); only access tokens take Bearer.
    const replay = provider();
    const bb = new BitbucketProvider({
      token: "api-token",
      user: "dev@example.com",
      fetch: replay.fetch,
    });
    await bb.listCommits(repo, 812);
    const basic = Buffer.from("dev@example.com:api-token").toString("base64");
    expect(replay.sent[0]?.headers.Authorization).toBe(`Basic ${basic}`);
  });

  test("maps inline comments and replies, and drops deleted ones", async () => {
    const { bb } = provider();
    const comments = await bb.listReviewComments(repo, 812);
    expect(comments.map((c) => c.id)).toEqual([33, 34, 36]);
    expect(comments[0]).toEqual({
      id: 33,
      body: "Please use `withRetry()` from the http client instead of this loop; it adds the request-id header.",
      author: { id: "dana", name: "Dana Reyes" },
      createdAt: "2026-10-05T14:02:11.000000+00:00",
      url: "https://bitbucket.org/acme/integrations-api/pull-requests/812/_/diff#comment-33",
      path: "services/integrations/partner.ts",
      line: 42,
    });
    expect(comments[1]?.inReplyTo).toBe(33);
    expect(comments[2]?.path).toBeUndefined();
  });

  test("lists PR commits, with or without a linked user", async () => {
    const { bb } = provider();
    const commits = await bb.listCommits(repo, 812);
    expect(commits).toEqual([
      {
        sha: "2b3c4d5e6f7a8b9c",
        date: "2026-10-06T09:05:00+00:00",
        message: "Use withRetry for partner calls",
        author: { id: "sam", name: "Sam Ortiz" },
      },
      {
        sha: "1f2e3d4c5b6a7980",
        date: "2026-10-05T11:00:00+00:00",
        message: "Retry partner calls",
      },
    ]);
  });

  test("opens a PR on the KB repo that closes its branch on merge", async () => {
    const { bb } = provider();
    const pr = await bb.openPullRequest(
      { owner: "acme", name: "team-kb" },
      {
        title: "homeostat: 2 knowledge candidates",
        body: "Drafted by the curator.",
        sourceBranch: "homeostat/curator-2026-10-13",
        targetBranch: "main",
      },
    );
    expect(pr).toEqual({ id: 41, url: "https://bitbucket.org/acme/team-kb/pull-requests/41" });
  });

  test("squash-merges a KB PR and closes its branch", async () => {
    const { bb, sent } = provider();
    await bb.mergePullRequest({ owner: "acme", name: "team-kb" }, 41);
    expect(sent).toHaveLength(1);
  });

  test("API errors carry the status and Bitbucket's message", async () => {
    const { bb } = provider();
    const err = await bb.listCommits({ owner: "acme", name: "private-repo" }, 1).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("lack one or more required privilege scopes");
  });
});

describe("BitbucketProvider.listOpenPullRequests", () => {
  test("lists open PRs with their branches", async () => {
    const { bb } = provider();
    expect(await bb.listOpenPullRequests({ owner: "acme", name: "team-kb" })).toEqual([
      {
        id: 40,
        title: "homeostat: candidates from lee",
        url: "https://bitbucket.org/acme/team-kb/pull-requests/40",
        author: { id: "lee", name: "Lee Park" },
        sourceBranch: "candidates/lee",
        targetBranch: "main",
      },
    ]);
  });
});

describe("BitbucketProvider.requestReviewers", () => {
  const kb = { owner: "acme", name: "team-kb" };

  test("adds a workspace member by nickname, keeping the existing reviewers", async () => {
    const { bb, sent } = provider();
    await bb.requestReviewers(kb, 41, ["Sam"]);
    expect(sent.at(-1)).toMatchObject({
      method: "PUT",
      body: { reviewers: [{ uuid: "{c2}" }, { uuid: "{c3}" }] },
    });
  });

  test("looks the workspace members up once", async () => {
    const { bb, sent } = provider();
    await bb.requestReviewers(kb, 41, ["sam"]);
    await bb.requestReviewers(kb, 41, ["sam"]);
    expect(sent.filter((r) => r.url.includes("/members")).length).toBe(2);
  });

  test("refuses a nickname that is not in the workspace, without changing the PR", async () => {
    const { bb, sent } = provider();
    const err = await bb.requestReviewers(kb, 41, ["kim"]).catch((e) => e);
    expect(err.message).toBe("kim is not a member of the acme workspace");
    expect(sent.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("BitbucketProvider.listCommits after the source branch is gone", () => {
  test("falls back to the pushes in the PR's activity, oldest first", async () => {
    const { bb } = provider();
    const commits = await bb.listCommits(repo, 790);
    expect(commits).toEqual([
      {
        sha: "aa11",
        date: "2026-10-04T09:00:00+00:00",
        message: "",
        author: { id: "sam", name: "Sam Ortiz" },
      },
      {
        sha: "cc33",
        date: "2026-10-05T16:00:00+00:00",
        message: "",
        author: { id: "sam", name: "Sam Ortiz" },
      },
    ]);
  });
});

describe("BitbucketProvider review actions", () => {
  const kb = { owner: "acme", name: "team-kb" };

  test("reads a PR with its body, reviewers and whether it conflicts", async () => {
    const { bb } = provider();
    expect(await bb.getPullRequest(kb, 42)).toEqual({
      id: 42,
      title: "homeostat: 2 lessons to review · lee · 2026-10-15",
      url: "https://bitbucket.org/acme/team-kb/pull-requests/42",
      author: { id: "homeostat-bot", name: "homeostat" },
      sourceBranch: "homeostat/review-lee-2026-10-15",
      targetBranch: "main",
      body: "| review | Use withRetry (`use-with-retry`) | 55 | | middle band |",
      state: "open",
      createdAt: "2026-10-15T06:00:00.000000+00:00",
      reviewers: [{ id: "dana", name: "Dana Reyes" }],
      conflicts: false,
    });
    expect((await bb.getPullRequest(kb, 43)).conflicts).toBe(true);
    const declined = await bb.getPullRequest(kb, 44);
    expect(declined.state).toBe("closed");
    expect(declined.conflicts).toBeUndefined();
  });

  test("fetches the diff as text", async () => {
    const { bb } = provider();
    expect(await bb.getPullRequestDiff(kb, 42)).toContain("+id: x");
  });

  test("comments, and declines", async () => {
    const { bb, sent } = provider();
    await bb.commentOnPullRequest(kb, 42, "Declined in review: duplicate");
    await bb.closePullRequest(kb, 42);
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname.split("/").at(-1)}`)).toEqual([
      "POST comments",
      "POST decline",
    ]);
  });
});
