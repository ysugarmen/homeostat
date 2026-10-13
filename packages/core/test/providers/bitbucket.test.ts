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
