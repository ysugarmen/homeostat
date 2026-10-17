import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DocPatcher,
  Draft,
  Drafter,
  NewPullRequest,
  OpenPullRequest,
  Provider,
  PullRequest,
  RepoRef,
  ReviewThread,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const MINE = "knowledge/frontend/use-the-shared-button-component.md";
const DRAFTED = "knowledge/frontend/use-colour-tokens-instead-of-hex-values.md";

/** A GitHub team KB on a bare origin; `ci` is the daily run's checkout, `lee` a developer's clone. */
function team() {
  const origin = mkdtempSync(join(tmpdir(), "homeostat-daily-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const ci = mkdtempSync(join(tmpdir(), "homeostat-daily-ci-"));
  cpSync(starter, ci, { recursive: true });
  const config = join(ci, "homeostat.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8")
      .replace("host: bitbucket", "host: github")
      .replace("repos: [acme/integrations-api, acme/web-app]", "repos: [acme/web-app]"),
  );
  const starterEntry = join(ci, "knowledge/integrations/outbound-http-retry-helper.md");
  writeFileSync(
    starterEntry,
    readFileSync(starterEntry, "utf8").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
      "https://github.com/acme/web-app/pull/812#discussion_r33",
    ),
  );
  const g = (dir: string, ...a: string[]) =>
    execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=ci", "-c", "user.email=ci@example.com", ...a],
      {
        encoding: "utf8",
      },
    ).trim();
  g(ci, "init", "-q", "-b", "main");
  g(ci, "add", "-A");
  g(ci, "commit", "-qm", "kb");
  g(ci, "remote", "add", "origin", origin);
  g(ci, "push", "-q", "origin", "main");
  const lee = mkdtempSync(join(tmpdir(), "homeostat-daily-lee-"));
  execFileSync("git", ["clone", "-q", origin, lee]);
  execFileSync("git", ["-C", lee, "config", "user.name", "Lee"]);
  execFileSync("git", ["-C", lee, "config", "user.email", "lee@example.com"]);
  return { origin, ci, lee, g };
}

/** Lee's PR #120 got a review from Sam that Lee acted on. */
class FakeProvider implements Provider {
  readonly kind = "github" as const;
  opened: { pr: NewPullRequest; id: number }[] = [];
  merged: number[] = [];
  reviewers: { id: number; logins: string[] }[] = [];
  open: OpenPullRequest[] = [];
  mergeError?: Error;
  commentPath: string;
  constructor(commentPath = "apps/web/src/Button.css") {
    this.commentPath = commentPath;
  }
  async listMergedPullRequests(_repo: RepoRef, _since: Date): Promise<PullRequest[]> {
    return [
      {
        id: 120,
        title: "Booking widget styles",
        url: "https://github.com/acme/web-app/pull/120",
        author: { id: "lee" },
        mergedAt: "2026-10-15T10:00:00Z",
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
        createdAt: "2026-10-15T08:00:00Z",
        url: "https://github.com/acme/web-app/pull/120#discussion_r9001",
        path: this.commentPath,
        line: 4,
      },
    ];
  }
  async listCommits() {
    return [{ sha: "a", date: "2026-10-15T09:00:00Z", message: "use tokens" }];
  }
  async openPullRequest(_repo: RepoRef, pr: NewPullRequest) {
    const id = 10 + this.opened.length;
    this.opened.push({ pr, id });
    this.open.push({ id, sourceBranch: pr.sourceBranch } as OpenPullRequest);
    return { id, url: `https://github.com/acme/team-kb/pull/${id}` };
  }
  async mergePullRequest(_repo: RepoRef, id: number) {
    if (this.mergeError) throw this.mergeError;
    this.merged.push(id);
    this.open = this.open.filter((p) => p.id !== id);
  }
  async requestReviewers(_repo: RepoRef, id: number, logins: string[]) {
    this.reviewers.push({ id, logins });
  }
}

const COLOUR_DRAFT: Draft = {
  title: "Use colour tokens instead of hex values",
  rule: "Reference colours through var(--color-*) tokens in apps/web component styles, never hex values.",
  why: "Hex values do not change with the theme, which broke dark mode.",
  area: "frontend",
};

class FakeDrafter implements Drafter {
  result: Draft | null;
  constructor(result: Draft | null = COLOUR_DRAFT) {
    this.result = result;
  }
  async draft(_t: ReviewThread): Promise<Draft | null> {
    return this.result;
  }
}

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: { GITHUB_TOKEN: "t" },
    now: () => new Date("2026-10-16T06:00:00Z"),
    background: () => {},
    drafter: new FakeDrafter(),
    ...extra,
  });
  return { code, stdout };
}

async function leeLearns(lee: string) {
  await run([
    "learn",
    "--dir",
    lee,
    "--author",
    "lee",
    "--area",
    "frontend",
    "--title",
    "Use the shared button component",
    "--rule",
    "Render buttons with <Button> from apps/web/ui, never a raw button tag.",
    "--why",
    "Raw buttons skip the focus ring and the analytics hook.",
  ]);
  await run(["sync", "--dir", lee]);
}

// Each test drives several git repos and CLI runs; under a full parallel run that takes a while.
describe("homeostat daily (automation, step 4)", { timeout: 30_000 }, () => {
  test("one run: the confident lesson merges, the uncertain one goes to a reviewer, state is recorded", async () => {
    const t = team();
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    const { code, stdout } = await run(["daily", "--dir", t.ci], { provider });
    expect(code).toBe(0);
    expect(stdout).toContain("lee: 1 merged, 1 to review, 0 declined");

    // Sam (senior) reviewed Lee's PR: confident, so it lands in Lee's daily PR and merges.
    const [daily, review] = provider.opened;
    expect(daily?.pr.sourceBranch).toBe("homeostat/daily-lee-2026-10-16");
    expect(daily?.pr.title).toBe("homeostat: daily lessons · lee · 2026-10-16");
    expect(daily?.pr.body).toContain("| merged | Use colour tokens instead of hex values");
    expect(provider.merged).toEqual([daily?.id]);
    const merged = t.g(t.origin, "show", `homeostat/daily-lee-2026-10-16:${DRAFTED}`);
    expect(merged).toContain("status: accepted");

    // Lee's own lesson (a member, written by hand) is in the middle band: a review PR for Sam.
    expect(review?.pr.sourceBranch).toBe("homeostat/review-lee-2026-10-16");
    expect(t.g(t.origin, "show", `homeostat/review-lee-2026-10-16:${MINE}`)).toContain(
      "status: accepted",
    );
    expect(provider.reviewers).toEqual([{ id: review?.id, logins: ["sam"] }]);

    const decisions = JSON.parse(t.g(t.origin, "show", "homeostat/state:decisions/lee.json"));
    expect(
      decisions.decided.map((d: { id: string; decision: string }) => [d.id, d.decision]),
    ).toEqual(
      expect.arrayContaining([
        ["use-colour-tokens-instead-of-hex-values", "merged"],
        ["use-the-shared-button-component", "review"],
      ]),
    );
    const report = JSON.parse(t.g(t.origin, "show", "homeostat/state:runs/2026-10-16.json"));
    expect(report.members).toEqual([
      expect.objectContaining({ member: "lee", merged: 1, review: 1, declined: 0 }),
    ]);
    expect(t.g(t.origin, "show", "homeostat/state:heartbeats/lee.json")).toContain(
      '"member": "lee"',
    );
  });

  test("the next run settles a closed review PR as declined, and Lee's sync clears the lesson", async () => {
    const t = team();
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(provider.opened.map((o) => o.pr.sourceBranch)).toEqual([
      "homeostat/review-lee-2026-10-16",
    ]);
    // The reviewer closes it without merging.
    provider.open = [];
    const next = await run(["daily", "--dir", t.ci, "--no-reviews"], {
      provider,
      now: () => new Date("2026-10-17T06:00:00Z"),
    });
    expect(next.stdout).toContain("no new lessons");
    const decided = JSON.parse(t.g(t.origin, "show", "homeostat/state:decisions/lee.json")).decided;
    expect(decided).toEqual([
      expect.objectContaining({
        id: "use-the-shared-button-component",
        decision: "declined",
        reason: "closed by a reviewer",
      }),
    ]);
    const synced = await run(["sync", "--dir", t.lee]);
    expect(synced.stdout).toContain("declined (closed by a reviewer)");
    expect(existsSync(join(t.lee, ".homeostat/pending", MINE))).toBe(false);
  });

  test("Slack gets the morning queue, and a reminder for lessons waiting more than 2 days", async () => {
    const t = team();
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    const posts: string[] = [];
    const slack = {
      provider,
      env: { GITHUB_TOKEN: "t", HOMEOSTAT_SLACK_WEBHOOK: "https://hooks.slack.com/services/x" },
      fetch: (async (_u: string, init: RequestInit) => {
        posts.push(JSON.parse(String(init.body)).text);
        return new Response("ok");
      }) as typeof fetch,
    };
    await run(["daily", "--dir", t.ci, "--no-reviews"], slack);
    expect(posts[0]).toContain("*Homeostat: 1 lesson waiting for review*");
    expect(posts[0]).toContain("• lee: 1 — https://github.com/acme/team-kb/pull/10");
    // Three days on, the review PR is still open.
    await run(["daily", "--dir", t.ci, "--no-reviews"], {
      ...slack,
      now: () => new Date("2026-10-19T06:00:00Z"),
    });
    expect(posts[1]).toContain("*Still waiting after 2 days: 1 lesson*");
    expect(posts[1]).toContain("• use-the-shared-button-component (lee, since 2026-10-16)");
  });

  test("a refused merge leaves the daily PR open and records its lessons for review", async () => {
    const t = team();
    const provider = new FakeProvider();
    provider.mergeError = new Error("branch protection: 1 approval required");
    const { stdout } = await run(["daily", "--dir", t.ci], { provider });
    expect(stdout).toContain("could not merge https://github.com/acme/team-kb/pull/10");
    const decided = JSON.parse(t.g(t.origin, "show", "homeostat/state:decisions/lee.json")).decided;
    expect(decided[0]).toMatchObject({ decision: "review", pr: "homeostat/daily-lee-2026-10-16" });
  });

  test("--dry-run decides and prints, but opens, merges and records nothing", async () => {
    const t = team();
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    const { stdout } = await run(["daily", "--dir", t.ci, "--dry-run"], { provider });
    expect(stdout).toContain("lee: 1 merged, 1 to review, 0 declined");
    expect(stdout).toContain("dry run");
    expect(provider.opened).toEqual([]);
    expect(() => t.g(t.origin, "rev-parse", "--verify", "homeostat/state")).toThrow();
  });

  test("the same lesson from a developer and from a review is decided once", async () => {
    const t = team();
    await run([
      "learn",
      "--dir",
      t.lee,
      "--author",
      "lee",
      "--area",
      "integrations",
      "--title",
      "Use the shared retry helper for partner calls",
      "--rule",
      "Wrap every partner API call in withRetry() from services/integrations/http.ts.",
      "--why",
      "Partner APIs time out; hand-rolled retries skipped the request-id header.",
    ]);
    await run(["sync", "--dir", t.lee]);
    const drafter = new FakeDrafter({
      title: "Use withRetry instead of hand-rolled retry loops",
      rule: "Call withRetry() from services/integrations/http.ts instead of writing retry loops.",
      why: "Hand-rolled loops dropped the request-id header.",
      area: "integrations",
    });
    const { stdout } = await run(["daily", "--dir", t.ci, "--dry-run"], {
      provider: new FakeProvider("services/integrations/partner.ts"),
      drafter,
      patcher: { propose: async () => null },
    });
    expect(
      stdout.match(/the same lesson as [a-z0-9-]+ in this run, which carries it/g),
    ).toHaveLength(1);
  });

  test("a pending document edit and a review patch to the same document become one change", async () => {
    const t = team();
    await run(
      [
        "learn",
        "--dir",
        t.lee,
        "--doc",
        "integrations/partner-calls",
        "--section",
        "timeouts",
        "--append",
        "--text",
        "Booking confirmation waits up to 30 seconds.",
      ],
      { now: () => new Date("2026-10-15T17:00:00Z") },
    ); // the day before the run: dates differ
    await run(["sync", "--dir", t.lee]);
    const patcher: DocPatcher = {
      propose: async () => ({
        path: "knowledge/integrations/docs/partner-calls.md",
        sectionId: "http-client",
        op: "append",
        body: "Wrap partner calls in withRetry().",
        reason: "the review moved partner calls to withRetry()",
      }),
    };
    const provider = new FakeProvider("services/integrations/partner.ts");
    const { stdout } = await run(["daily", "--dir", t.ci], {
      provider,
      drafter: new FakeDrafter(null),
      patcher,
    });
    expect(stdout.match(/knowledge\/integrations\/docs\/partner-calls\.md/g)).toHaveLength(1);
    expect(stdout).toContain("includes a section patch from review");
    const doc = t.g(
      t.origin,
      "show",
      "homeostat/review-lee-2026-10-16:knowledge/integrations/docs/partner-calls.md",
    );
    expect(doc).toContain("Booking confirmation waits up to 30 seconds.");
    expect(doc).toContain("Wrap partner calls in withRetry().");
    expect(doc).toContain("updated: 2026-10-16");
  });
});
