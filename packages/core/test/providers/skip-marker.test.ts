import { describe, expect, test } from "vitest";
import { BitbucketProvider } from "../../src/providers/bitbucket.ts";
import { GitHubProvider } from "../../src/providers/github.ts";

const repo = { owner: "acme", name: "web-app" };
const since = new Date("2026-10-01T00:00:00Z");
const json = (body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const ghPr = (n: number, extra: object) => ({
  number: n,
  title: "Retry partner calls",
  html_url: `https://github.com/acme/web-app/pull/${n}`,
  user: { login: "lee" },
  updated_at: "2026-10-12T10:00:00Z",
  merged_at: "2026-10-12T10:00:00Z",
  head: { ref: "f" },
  base: { ref: "main" },
  ...extra,
});

const bbPr = (id: number, extra: object) => ({
  id,
  title: "Retry partner calls",
  author: { display_name: "Lee", nickname: "lee", account_id: "1" },
  updated_on: "2026-10-12T10:00:00Z",
  source: { branch: { name: "f" } },
  destination: { branch: { name: "main" } },
  links: { html: { href: `https://bitbucket.org/acme/web-app/pull-requests/${id}` } },
  ...extra,
});

describe("the homeostat:skip marker (T5)", () => {
  test("GitHub: a label, the title or the description", async () => {
    const gh = new GitHubProvider({
      token: "t",
      fetch: json([
        ghPr(1, { labels: [{ name: "homeostat:skip" }] }),
        ghPr(2, { title: "Rotate keys [homeostat:skip]" }),
        ghPr(3, { body: "Incident fix.\n\nhomeostat:skip" }),
        ghPr(4, { labels: [{ name: "bug" }], body: "Plain." }),
      ]),
    });
    const prs = await gh.listMergedPullRequests(repo, since);
    expect(prs.map((p) => [p.id, p.skipRequested ?? false])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ]);
  });

  test("Bitbucket: the title or the description (it has no PR labels)", async () => {
    const bb = new BitbucketProvider({
      token: "t",
      fetch: json({
        values: [
          bbPr(1, { title: "homeostat:skip rotate keys" }),
          bbPr(2, { description: "homeostat:skip" }),
          bbPr(3, { description: "Plain." }),
        ],
      }),
    });
    const prs = await bb.listMergedPullRequests(repo, since);
    expect(prs.map((p) => [p.id, p.skipRequested ?? false])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });
});
