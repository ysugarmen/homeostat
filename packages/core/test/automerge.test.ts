import { describe, expect, test } from "vitest";
import { autoMergeDecision, splitAutoMerge } from "../src/automerge.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { BitbucketProvider } from "../src/providers/bitbucket.ts";
import { GitHubProvider } from "../src/providers/github.ts";
import type { Frontmatter } from "../src/schema.ts";

function config(autoMerge = ""): Config {
  const { config } = parseConfig(`version: 1
team:
  members:
    - { id: sam, role: senior }
    - { id: lee, role: member }
areas:
  frontend: ["apps/web/**"]
  integrations: ["services/integrations/**"]
scoring:
  autoMergeThreshold: 3
${autoMerge ? `  autoMerge: ${autoMerge}\n` : ""}`);
  if (!config) throw new Error("bad test config");
  return config;
}

const clean: Frontmatter = {
  id: "use-colour-tokens",
  title: "Use colour tokens",
  area: "frontend",
  scope: ["apps/web/**"],
  status: "accepted",
  score: 4,
  owner: "sam",
  source: {
    type: "pr-feedback",
    url: "https://github.com/acme/web-app/pull/1#discussion_r1",
    author: "sam",
    changedCode: true,
  },
  created: "2026-10-14",
  lastConfirmed: "2026-10-14",
  tokens: 40,
};

const decide = (fm: Partial<Frontmatter>, risks: string[] = [], yaml = "") =>
  autoMergeDecision({ frontmatter: { ...clean, ...fm }, risks }, config(yaml));

describe("autoMergeDecision (T1)", () => {
  test("a clean, human-originated entry at the threshold auto-merges", () => {
    expect(decide({})).toEqual({ auto: true });
  });

  test.each<[string, Partial<Frontmatter>, string[], string, string]>([
    ["below the threshold", { status: "candidate", score: 2 }, [], "", "below the threshold"],
    [
      "agent-written (handoff)",
      { source: { type: "agent-handoff", author: "sam" } },
      [],
      "",
      "only review feedback",
    ],
    ["manual", { source: { type: "manual", author: "sam" } }, [], "", "only review feedback"],
    [
      "a deep-dive edit",
      { source: { type: "deep-dive", author: "sam" } },
      [],
      "",
      "only review feedback",
    ],
    [
      "feedback with no code change",
      { source: { ...clean.source, changedCode: false } },
      [],
      "",
      "no code change",
    ],
    [
      "by a non-member",
      { source: { ...clean.source, author: "mallory" } },
      [],
      "",
      "not a team member",
    ],
    ["flagged by the scanner", {}, ["runs downloaded code"], "", "risky-content"],
    [
      "flagged by a member",
      { flags: [{ by: "lee", reason: "wrong", date: "2026-10-14" }] },
      [],
      "",
      "flagged by a member",
    ],
    ["in an excluded area", {}, [], "{ excludeAreas: [frontend] }", "always needs a reviewer"],
    [
      "outside the allowed areas",
      {},
      [],
      "{ areas: [integrations] }",
      "not in scoring.autoMerge.areas",
    ],
    ["with auto-merge off", {}, [], "{ enabled: false }", "auto-merge is off"],
  ])("never when %s", (_, fm, risks, yaml, reason) => {
    const d = decide(fm, risks, yaml);
    expect(d.auto).toBe(false);
    expect(d.auto ? "" : d.reason).toContain(reason);
  });
});

describe("splitAutoMerge", () => {
  test("caps auto-merges per run and sends the rest to review", () => {
    const entries = ["a", "b", "c"].map((id) => ({ frontmatter: { ...clean, id }, risks: [] }));
    const { auto, review } = splitAutoMerge(entries, config("{ maxPerRun: 2 }"));
    expect(auto.map((e) => e.frontmatter.id)).toEqual(["a", "b"]);
    expect(review.map((r) => [r.entry.frontmatter.id, r.reason])).toEqual([
      ["c", "over the per-run cap (2)"],
    ]);
  });
});

function recordingFetch() {
  const sent: { method: string; url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ method: init.method ?? "GET", url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("mergePullRequest", () => {
  const kb = { owner: "acme", name: "team-kb" };

  test("GitHub squash-merges through the pulls API", async () => {
    const { fetch, sent } = recordingFetch();
    await new GitHubProvider({ token: "t", fetch }).mergePullRequest(kb, 7);
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "https://api.github.com/repos/acme/team-kb/pulls/7/merge",
        body: { merge_method: "squash" },
      },
    ]);
  });

  test("Bitbucket squash-merges and closes the branch", async () => {
    const { fetch, sent } = recordingFetch();
    await new BitbucketProvider({ token: "t", fetch }).mergePullRequest(kb, 7);
    expect(sent).toEqual([
      {
        method: "POST",
        url: "https://api.bitbucket.org/2.0/repositories/acme/team-kb/pullrequests/7/merge",
        body: { merge_strategy: "squash", close_source_branch: true },
      },
    ]);
  });
});
