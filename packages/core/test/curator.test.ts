import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { apiAsker, type ClaudeClient } from "../src/claude.ts";
import { curate } from "../src/curator/curate.ts";
import { ClaudeDrafter, type Draft, type Drafter, draftPrompt } from "../src/curator/draft.ts";
import { type ReviewThread, reviewThreads } from "../src/curator/threads.ts";
import { commentKeyOf, parseCommentUrl } from "../src/curator/urls.ts";
import { parseEntry } from "../src/entry.ts";
import { BitbucketProvider } from "../src/providers/bitbucket.ts";
import type { PullRequest, ReviewComment } from "../src/providers/types.ts";
import { validate } from "../src/validate.ts";
import { replayFetch } from "./providers/replay.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;

/** The starter KB with a sources section, optionally without its entry for comment 33. */
function kbFiles({ withExisting = false } = {}) {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md") || f.endsWith(".yaml")) files[f] = readFileSync(join(starter, f), "utf8");
  }
  files["homeostat.yaml"] =
    `${(files["homeostat.yaml"] ?? "").replace(/\n# Where the curator[\s\S]*$/, "")}
sources:
  host: bitbucket
  kbRepo: acme/team-kb
  repos: [acme/integrations-api]
`;
  if (!withExisting) delete files["knowledge/integrations/outbound-http-retry-helper.md"];
  delete files["README.md"];
  return files;
}

const pr: PullRequest = {
  id: 7,
  title: "Retry partner calls",
  url: "https://example.com/pr/7",
  author: { id: "sam" },
  mergedAt: "2026-10-07T00:00:00Z",
  sourceBranch: "f",
  targetBranch: "main",
};
const comment = (id: number, author: string, at: string, inReplyTo?: number): ReviewComment => ({
  id,
  body: `comment ${id}`,
  author: { id: author },
  createdAt: at,
  url: `https://example.com/c/${id}`,
  path: "services/integrations/partner.ts",
  line: 3,
  ...(inReplyTo ? { inReplyTo } : {}),
});

describe("reviewThreads", () => {
  test("groups replies, including replies to replies, under the reviewer's comment", () => {
    const threads = reviewThreads(
      "acme/api",
      pr,
      [
        comment(1, "dana", "2026-10-05T10:00:00Z"),
        comment(2, "sam", "2026-10-05T11:00:00Z", 1),
        comment(3, "dana", "2026-10-05T12:00:00Z", 2),
      ],
      [{ sha: "a", date: "2026-10-05T11:30:00Z", message: "fix" }],
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.id).toBe(1);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual([2, 3]);
    expect(threads[0]?.changedCode).toBe(true);
  });

  test("the PR author's own comments are not feedback", () => {
    expect(reviewThreads("acme/api", pr, [comment(1, "sam", "2026-10-05T10:00:00Z")], [])).toEqual(
      [],
    );
  });

  test("no commit after the comment means no code change", () => {
    const [thread] = reviewThreads(
      "acme/api",
      pr,
      [comment(1, "dana", "2026-10-05T10:00:00Z")],
      [{ sha: "a", date: "2026-10-05T09:00:00Z", message: "before" }],
    );
    expect(thread?.changedCode).toBe(false);
  });
});

describe("comment URLs", () => {
  test("every form of a comment link maps to the same key", () => {
    const keys = [
      "https://bitbucket.org/acme/api/pull-requests/812#comment-33",
      "https://bitbucket.org/acme/api/pull-requests/812/_/diff#comment-33",
      "https://bitbucket.org/Acme/API/pull-requests/812/overview#comment-33",
    ].map(commentKeyOf);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeDefined();
  });

  test("non-comment URLs have no key", () => {
    expect(commentKeyOf("https://example.com/wiki")).toBeUndefined();
    expect(commentKeyOf(undefined)).toBeUndefined();
  });

  test("parses GitHub review comment links", () => {
    expect(parseCommentUrl("https://github.com/acme/web/pull/120#discussion_r9001")).toEqual({
      host: "github",
      repo: { owner: "acme", name: "web" },
      pullRequest: 120,
      comment: 9001,
    });
  });
});

describe("draftPrompt", () => {
  test("carries the thread, the location and the areas, and nothing invented", () => {
    const [thread] = reviewThreads(
      "acme/api",
      pr,
      [comment(1, "dana", "2026-10-05T10:00:00Z"), comment(2, "sam", "2026-10-05T11:00:00Z", 1)],
      [],
    );
    const prompt = draftPrompt(thread as ReviewThread, {
      areas: { integrations: ["services/**"] },
    });
    expect(prompt).toContain("Pull request: Retry partner calls (by sam)");
    expect(prompt).toContain("Comment on: services/integrations/partner.ts:3");
    expect(prompt).toContain("dana: comment 1\n\nsam: comment 2");
    expect(prompt).toContain("- integrations: services/**");
    expect(prompt).toContain("- core: applies everywhere");
  });
});

describe("ClaudeDrafter", () => {
  const thread = reviewThreads(
    "acme/api",
    pr,
    [comment(1, "dana", "2026-10-05T10:00:00Z")],
    [],
  )[0] as ReviewThread;

  function stub(parsed: unknown, stopReason = "end_turn") {
    const calls: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          parse: async (params: Record<string, unknown>) => {
            calls.push(params);
            return { stop_reason: stopReason, parsed_output: parsed };
          },
        },
      },
    } as unknown as ClaudeClient;
    return { client, calls };
  }

  test("sends the configured model and effort with a structured-output format and fallbacks", async () => {
    const { client, calls } = stub({ keep: true, title: " T ", rule: "R", why: "W", area: "core" });
    const drafter = new ClaudeDrafter(
      apiAsker({ client, model: "claude-opus-5-5", effort: "medium" }),
    );
    expect(await drafter.draft(thread, { areas: {} })).toEqual({
      title: "T",
      rule: "R",
      why: "W",
      area: "core",
    });
    expect(calls[0]).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "medium", format: expect.anything() },
    });
  });

  test("returns null when the model says there is no lasting rule", async () => {
    const { client } = stub({ keep: false, title: "", rule: "", why: "", area: "core" });
    const drafter = new ClaudeDrafter(apiAsker({ client, model: "m", effort: "low" }));
    expect(await drafter.draft(thread, { areas: {} })).toBeNull();
  });

  test("returns null on a refusal", async () => {
    const { client } = stub(null, "refusal");
    const drafter = new ClaudeDrafter(apiAsker({ client, model: "m", effort: "low" }));
    expect(await drafter.draft(thread, { areas: {} })).toBeNull();
  });
});

describe("curate", () => {
  class FakeDrafter implements Drafter {
    seen: ReviewThread[] = [];
    private readonly reply: Partial<Draft> | null;
    constructor(reply: Partial<Draft> | null = {}) {
      this.reply = reply;
    }
    async draft(t: ReviewThread): Promise<Draft | null> {
      this.seen.push(t);
      if (this.reply === null) return null;
      return {
        title: "Use withRetry for partner calls",
        rule: "Wrap partner HTTP calls in withRetry() from @app/http-client.",
        why: "The reviewer asked for it because the helper adds the request-id header.",
        area: "integrations",
        ...this.reply,
      };
    }
  }

  const run = (drafter: Drafter, files = kbFiles()) => {
    const provider = new BitbucketProvider({ token: "t", fetch: replayFetch("bitbucket").fetch });
    return curate({
      files,
      provider,
      drafter,
      since: new Date("2026-10-06T00:00:00Z"),
      today: "2026-10-13",
    });
  };

  test("drafts one accepted entry for reviewed-then-changed feedback from a member", async () => {
    const drafter = new FakeDrafter();
    const result = await run(drafter);
    expect(drafter.seen.map((t) => t.root.id)).toEqual([33]);
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry?.path).toBe("knowledge/integrations/use-withretry-for-partner-calls.md");
    expect(entry?.frontmatter).toMatchObject({
      status: "accepted",
      score: 4,
      owner: "dana",
      area: "integrations",
      scope: ["services/integrations/**", "packages/http-client/**"],
      source: {
        type: "pr-feedback",
        author: "dana",
        changedCode: true,
        url: "https://bitbucket.org/acme/integrations-api/pull-requests/812/_/diff#comment-33",
      },
    });
    expect(parseEntry(entry?.text ?? "").issues).toEqual([]);
    const after = validate({ ...kbFiles(), [entry?.path ?? ""]: entry?.text ?? "" });
    expect(after.ok).toBe(true);
  });

  test("reports why each other thread was skipped", async () => {
    const result = await run(new FakeDrafter());
    expect(result.skipped).toEqual([
      {
        url: "https://bitbucket.org/acme/integrations-api/pull-requests/815/_/diff#comment-51",
        reason: "reviewer rae has no member handle in homeostat.yaml",
      },
      {
        url: "https://bitbucket.org/acme/integrations-api/pull-requests/812/_/overview#comment-36",
        reason: "no code change after the comment",
      },
    ]);
    expect(result.scanned).toEqual([
      { repo: "acme/integrations-api", pullRequests: 3, threads: 3 },
    ]);
  });

  test("feedback already in the KB is not drafted again, whatever its URL form", async () => {
    const drafter = new FakeDrafter();
    const result = await run(drafter, kbFiles({ withExisting: true }));
    expect(drafter.seen).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("already in the knowledge base");
  });

  test("a thread the model declines produces no entry", async () => {
    const result = await run(new FakeDrafter(null));
    expect(result.entries).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("no lasting rule in the thread");
  });

  test("an unknown area falls back to core with a global scope", async () => {
    const result = await run(new FakeDrafter({ area: "payments" }));
    expect(result.entries[0]?.frontmatter).toMatchObject({ area: "core", scope: ["**"] });
  });

  test("a draft that breaks the rules is skipped with the reason", async () => {
    const long = Array.from({ length: 70 }, () => "word").join(" ");
    const result = await run(new FakeDrafter({ rule: long }));
    expect(result.entries).toEqual([]);
    expect(result.skipped.some((s) => s.reason.includes("## Rule has 70 words; max 60"))).toBe(
      true,
    );
  });

  test("an id that is taken gets a suffix", async () => {
    const result = await run(new FakeDrafter({ title: "Redact before logging" }));
    expect(result.entries[0]?.frontmatter.id).toBe("redact-before-logging-2");
  });

  test("a KB without sources is refused clearly", async () => {
    const files = kbFiles();
    files["homeostat.yaml"] = (files["homeostat.yaml"] ?? "").replace(/\nsources:[\s\S]*$/, "\n");
    await expect(run(new FakeDrafter(), files)).rejects.toThrow("no sources section");
  });
});
