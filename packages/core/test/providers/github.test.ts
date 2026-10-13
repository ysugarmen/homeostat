import { describe, expect, test } from "vitest";
import { GitHubProvider } from "../../src/providers/github.ts";
import { ProviderError } from "../../src/providers/http.ts";
import { replayFetch } from "./replay.ts";

const repo = { owner: "acme", name: "web-app" };
const since = new Date("2026-10-06T00:00:00Z");

function provider() {
  const replay = replayFetch("github");
  return { ...replay, gh: new GitHubProvider({ token: "test-token", fetch: replay.fetch }) };
}

describe("GitHubProvider", () => {
  test("lists merged PRs since the date, skipping unmerged ones", async () => {
    const { gh } = provider();
    const prs = await gh.listMergedPullRequests(repo, since);
    expect(prs.map((p) => p.id)).toEqual([120, 110]);
    expect(prs[0]).toEqual({
      id: 120,
      title: "Use design tokens in the booking widget",
      url: "https://github.com/acme/web-app/pull/120",
      author: { id: "lee" },
      mergedAt: "2026-10-10T11:59:00Z",
      sourceBranch: "feature/tokens",
      targetBranch: "main",
    });
  });

  test("stops paginating once PRs are older than `since`", async () => {
    const { gh, sent } = provider();
    await gh.listMergedPullRequests(repo, since);
    expect(sent).toHaveLength(2);
  });

  test("sends the API version and bearer token", async () => {
    const { gh, sent } = provider();
    await gh.listCommits(repo, 120);
    expect(sent[0]?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  test("maps review comments, keeping the original line for outdated ones", async () => {
    const { gh } = provider();
    const comments = await gh.listReviewComments(repo, 120);
    expect(comments).toEqual([
      {
        id: 9001,
        body: "Please use `var(--color-primary)` here instead of the hex value; it breaks dark mode.",
        author: { id: "sam" },
        createdAt: "2026-10-08T15:00:00Z",
        url: "https://github.com/acme/web-app/pull/120#discussion_r9001",
        path: "apps/web/src/BookingWidget.css",
        line: 14,
      },
      {
        id: 9002,
        body: "Fixed.",
        author: { id: "lee" },
        createdAt: "2026-10-09T09:00:00Z",
        url: "https://github.com/acme/web-app/pull/120#discussion_r9002",
        path: "apps/web/src/BookingWidget.css",
        line: 14,
        inReplyTo: 9001,
      },
    ]);
  });

  test("lists PR commits, with or without a linked account", async () => {
    const { gh } = provider();
    expect(await gh.listCommits(repo, 120)).toEqual([
      {
        sha: "aaa000",
        date: "2026-10-08T10:00:00Z",
        message: "Booking widget styles",
        author: { id: "lee", name: "Lee Park" },
      },
      { sha: "aaa111", date: "2026-10-09T08:55:00Z", message: "Use colour tokens" },
    ]);
  });

  test("opens a PR on the KB repo", async () => {
    const { gh } = provider();
    const pr = await gh.openPullRequest(
      { owner: "acme", name: "team-kb" },
      {
        title: "kbx: 2 knowledge candidates",
        body: "Drafted by the curator.",
        sourceBranch: "kbx/curator-2026-10-13",
        targetBranch: "main",
      },
    );
    expect(pr).toEqual({ id: 7, url: "https://github.com/acme/team-kb/pull/7" });
  });

  test("API errors carry the status and GitHub's message", async () => {
    const { gh } = provider();
    const err = await gh.listCommits({ owner: "acme", name: "private-repo" }, 1).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(404);
    expect(err.message).toContain("Not Found");
  });
});

describe("GitHubProvider.listOpenPullRequests", () => {
  test("lists open PRs with their branches", async () => {
    const { gh } = provider();
    expect(await gh.listOpenPullRequests({ owner: "acme", name: "team-kb" })).toEqual([
      {
        id: 6,
        title: "kbx: candidates from lee",
        url: "https://github.com/acme/team-kb/pull/6",
        author: { id: "lee" },
        sourceBranch: "candidates/lee",
        targetBranch: "main",
      },
    ]);
  });
});
