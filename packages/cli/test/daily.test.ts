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
import { formatTopicFile, parseEntry, ruleSection } from "@homeostat/core";
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
  opened: { pr: NewPullRequest; id: number }[] = [];
  merged: number[] = [];
  reviewers: { id: number; logins: string[] }[] = [];
  open: OpenPullRequest[] = [];
  mergeError?: Error;
  commentPath: string;
  constructor(commentPath = "apps/web/src/Button.css") {
    this.commentPath = commentPath;
  }
  /** KB-repo PR branches a reviewer merged. */
  kbMerged: string[] = [];
  async listMergedPullRequests(repo: RepoRef, _since: Date): Promise<PullRequest[]> {
    if (repo.name === "team-kb") {
      return this.kbMerged.map((b, i) => ({
        id: 50 + i,
        title: b,
        url: `https://github.com/acme/team-kb/pull/${50 + i}`,
        author: { id: "lee" },
        mergedAt: "2026-10-16T12:00:00Z",
        sourceBranch: b,
        targetBranch: "main",
      }));
    }
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
  reviewError?: Error;
  /** A login the host refuses, as GitHub does for the PR's own author. */
  refuse?: string;
  async requestReviewers(_repo: RepoRef, id: number, logins: string[]) {
    if (this.reviewError) throw this.reviewError;
    if (this.refuse && logins.includes(this.refuse))
      throw new Error("GitHub API 422: Review cannot be requested from pull request author.");
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
    const report = JSON.parse(
      t.g(t.origin, "show", "homeostat/state:runs/2026-10-16T06-00-00Z.json"),
    );
    expect(report.members).toEqual([
      expect.objectContaining({ member: "lee", merged: 1, review: 1, declined: 0 }),
    ]);
    // What each lesson said stays in the report, so a decision can be checked later.
    expect(report.lessons).toContainEqual(
      expect.objectContaining({
        id: "use-the-shared-button-component",
        title: "Use the shared button component",
        rule: "Render buttons with <Button> from apps/web/ui, never a raw button tag.",
      }),
    );
    expect(t.g(t.origin, "show", "homeostat/state:heartbeats/lee.json")).toContain(
      '"member": "lee"',
    );
  });

  test("review PRs open after every daily PR has merged, on top of them; daily branches skip CI", async () => {
    const t = team();
    // Dana, handled first, has a lesson for review; Lee's daily PR merges after it in the run.
    const dana = mkdtempSync(join(tmpdir(), "homeostat-daily-dana-"));
    execFileSync("git", ["clone", "-q", t.origin, dana]);
    execFileSync("git", ["-C", dana, "config", "user.name", "Dana"]);
    execFileSync("git", ["-C", dana, "config", "user.email", "dana@example.com"]);
    await run([
      "learn",
      "--dir",
      dana,
      "--author",
      "dana",
      "--area",
      "frontend",
      "--title",
      "Keep colours consistent with the design system",
      "--rule",
      "Pick colours the design system already offers rather than inventing new shades.",
      "--why",
      "Copied palettes drifted from the theme after the rebrand.",
    ]);
    await run(["sync", "--dir", dana]);
    await leeLearns(t.lee);

    // A host whose merges land on main, recording the order of opens and merges.
    const events: string[] = [];
    class LandingProvider extends FakeProvider {
      override async openPullRequest(repo: RepoRef, pr: NewPullRequest) {
        events.push(`open ${pr.sourceBranch}`);
        return super.openPullRequest(repo, pr);
      }
      override async mergePullRequest(repo: RepoRef, id: number) {
        const branch = this.opened.find((o) => o.id === id)?.pr.sourceBranch ?? "";
        t.g(t.origin, "update-ref", "refs/heads/main", `refs/heads/${branch}`);
        events.push(`merge ${branch}`);
        return super.mergePullRequest(repo, id);
      }
    }
    const provider = new LandingProvider();
    const { stdout } = await run(["daily", "--dir", t.ci], { provider });
    expect(stdout).toContain("dana: 0 merged, 1 to review");
    expect(stdout).toContain("lee: 1 merged, 1 to review");

    const firstReview = events.findIndex((e) => e.startsWith("open homeostat/review-"));
    const lastMerge = events.findLastIndex((e) => e.startsWith("merge "));
    expect(firstReview).toBeGreaterThan(lastMerge);
    // Both review PRs are cut from the main that already holds Lee's merged lesson.
    for (const review of ["homeostat/review-dana-2026-10-16", "homeostat/review-lee-2026-10-16"])
      t.g(t.origin, "merge-base", "--is-ancestor", "homeostat/daily-lee-2026-10-16", review);
    const subject = (ref: string) => t.g(t.origin, "log", "-1", "--format=%s", ref);
    expect(subject("homeostat/daily-lee-2026-10-16")).toContain("[skip ci]");
    expect(subject("homeostat/review-dana-2026-10-16")).not.toContain("[skip ci]");
  });

  test("with named reviewers, only they are asked, not the area's senior", async () => {
    const t = team();
    const config = join(t.ci, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "team:\n  members:",
        "team:\n  reviewers: [dana]\n  members:",
      ),
    );
    t.g(t.ci, "commit", "-qam", "dana reviews");
    t.g(t.ci, "push", "-q", "origin", "main");
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(provider.reviewers.map((r) => r.logins)).toEqual([["dana"]]);
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

  test("the morning notice mentions the named reviewers in Slack", async () => {
    const t = team();
    const config = join(t.ci, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8")
        .replace("team:\n  members:", "team:\n  reviewers: [dana]\n  members:")
        .replace('handle: "@dana"', 'handle: "@dana"\n      slack: U0DANA01'),
    );
    t.g(t.ci, "commit", "-qam", "dana reviews, on Slack");
    t.g(t.ci, "push", "-q", "origin", "main");
    await leeLearns(t.lee);
    const posts: string[] = [];
    await run(["daily", "--dir", t.ci, "--no-reviews"], {
      provider: new FakeProvider(),
      env: { GITHUB_TOKEN: "t", HOMEOSTAT_SLACK_WEBHOOK: "https://hooks.slack.com/services/x" },
      fetch: (async (_u: string, init: RequestInit) => {
        posts.push(JSON.parse(String(init.body)).text);
        return new Response("ok");
      }) as typeof fetch,
    });
    expect(posts[0]?.startsWith("<@U0DANA01> *Homeostat: 1 lesson waiting for review*")).toBe(true);
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
      "Use the shared job lock for partner sync jobs",
      "--rule",
      "Wrap every partner sync job in withLock() from services/integrations/lock.ts.",
      "--why",
      "Two runners once synced the same partner twice.",
    ]);
    await run(["sync", "--dir", t.lee]);
    const drafter = new FakeDrafter({
      title: "Use withLock for partner sync jobs",
      rule: "Call withLock() from services/integrations/lock.ts around every partner sync job.",
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

  test("copies of a lesson the KB already has all reconfirm it; none is added", async () => {
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
    expect(stdout).not.toContain("merged   use-");
    expect(stdout.match(/outbound-http-retry-helper/g)?.length).toBe(2);
  });

  test("two developers flagging one rule make one change carrying both flags", async () => {
    // From the demo: each flag went into its own daily PR, and the second conflicted.
    const t = team();
    const dana = mkdtempSync(join(tmpdir(), "homeostat-daily-dana-"));
    execFileSync("git", ["clone", "-q", t.origin, dana]);
    execFileSync("git", ["-C", dana, "config", "user.name", "Dana"]);
    execFileSync("git", ["-C", dana, "config", "user.email", "dana@example.com"]);
    const rule = "outbound-http-retry-helper";
    for (const [dir, reason] of [
      [t.lee, "withRetry moved to packages/net"],
      [dana, "withRetry was renamed"],
    ] as const) {
      await run(["flag", rule, "--dir", dir, "--reason", reason]);
      await run(["sync", "--dir", dir]);
    }
    const provider = new FakeProvider();
    const { stdout } = await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(stdout.match(/merged {3}outbound-http-retry-helper/g)?.length).toBe(2);
    const path = "knowledge/integrations/outbound-http-retry-helper.md";
    const carrying = provider.opened.filter(
      (o) =>
        o.pr.sourceBranch.startsWith("homeostat/daily-") &&
        t.g(t.origin, "show", `${o.pr.sourceBranch}:${path}`) !==
          t.g(t.origin, "show", `main:${path}`),
    );
    expect(carrying).toHaveLength(1);
    const text = t.g(t.origin, "show", `${carrying[0]?.pr.sourceBranch}:${path}`);
    expect(text).toContain("status: disputed");
    expect(text).toContain("withRetry moved to packages/net");
    expect(text).toContain("withRetry was renamed");
  });

  test("a disputed rule gets a review PR with a drafted fix; closing it retires the rule", async () => {
    // From the demo: three rules stayed disputed for days with nothing asking anyone to act.
    const t = team();
    const path = "knowledge/integrations/outbound-http-retry-helper.md";
    await run([
      "flag",
      "outbound-http-retry-helper",
      "--dir",
      t.ci,
      "--by",
      "lee",
      "--reason",
      "withRetry moved to @acme/net",
      "--branch",
      "main",
      "--push",
    ]);
    t.g(t.ci, "reset", "-q", "--hard", "origin/main");
    const fixer = {
      fix: async () => ({
        title: "Use the shared retry helper from @acme/net",
        rule: "Wrap every outbound HTTP call in withRetry() from @acme/net.",
        why: "Hand-rolled retries skipped the request-id header.",
      }),
    };
    const provider = new FakeProvider();
    const first = await run(["daily", "--dir", t.ci, "--no-reviews"], { provider, fixer });
    const branch = "homeostat/review-dispute-outbound-http-retry-helper-2026-10-16";
    expect(first.stdout).toContain("for the disputed outbound-http-retry-helper");
    expect(provider.opened.map((o) => o.pr.sourceBranch)).toEqual([branch]);
    const proposed = t.g(t.origin, "show", `${branch}:${path}`);
    expect(proposed).toContain("status: accepted");
    expect(proposed).toContain("withRetry() from @acme/net");
    expect(proposed).not.toContain("flags:");
    expect(provider.reviewers.length).toBeGreaterThan(0);

    // The same day again: the PR is still open, so no second one.
    await run(["daily", "--dir", t.ci, "--no-reviews"], { provider, fixer });
    expect(provider.opened).toHaveLength(1);

    // A reviewer closes it: the next run retires the rule through the daily PR.
    provider.open = [];
    const next = await run(["daily", "--dir", t.ci, "--no-reviews"], {
      provider,
      fixer,
      now: () => new Date("2026-10-17T06:00:00Z"),
    });
    expect(next.stdout).toContain("retired: a reviewer closed its dispute PR");
    const daily = provider.opened.at(-1)?.pr.sourceBranch ?? "";
    expect(daily).toBe("homeostat/daily-lee-2026-10-17");
    expect(t.g(t.origin, "show", `${daily}:${path}`)).toContain("status: retired");
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

  test("a refused review request is reported, not swallowed", async () => {
    const t = team();
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    provider.reviewError = new Error("Reviews may only be requested from collaborators");
    const { stdout } = await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(stdout).toContain(
      "could not request @sam (Reviews may only be requested from collaborators)",
    );
    expect(stdout).toContain("reviewers must have access to acme/team-kb");
    const report = JSON.parse(
      t.g(t.origin, "show", "homeostat/state:runs/2026-10-16T06-00-00Z.json"),
    );
    expect(report.members[0].reviewError).toContain("could not request @sam");
  });

  test("a new lesson that repeats one waiting in review waits with it", async () => {
    const t = team();
    await leeLearns(t.lee);
    const provider = new FakeProvider();
    await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(provider.opened.map((o) => o.pr.sourceBranch)).toEqual([
      "homeostat/review-lee-2026-10-16",
    ]);
    // The next day a review drafts the same lesson; its twin is still waiting in review.
    const { stdout } = await run(["daily", "--dir", t.ci, "--dry-run"], {
      provider,
      now: () => new Date("2026-10-17T06:00:00Z"),
      drafter: new FakeDrafter({
        title: "Use the shared button component",
        rule: "Use the Button component from apps/web/ui for every button.",
        why: "Raw buttons miss the focus ring.",
        area: "frontend",
      }),
      patcher: { propose: async () => null },
    });
    expect(stdout).toContain(
      "the same lesson as use-the-shared-button-component, which is waiting in review: decide them together",
    );
  });

  test("review threads that gave no lesson are listed with the reason", async () => {
    const t = team();
    const { stdout } = await run(["daily", "--dir", t.ci], {
      provider: new FakeProvider(),
      drafter: new FakeDrafter(null),
    });
    expect(stdout).toContain("reviews read with no lesson:");
    expect(stdout).toContain(
      "https://github.com/acme/web-app/pull/120#discussion_r9001: no lasting rule in the thread",
    );
    const report = JSON.parse(
      t.g(t.origin, "show", "homeostat/state:runs/2026-10-16T06-00-00Z.json"),
    );
    expect(report.skipped).toEqual([
      {
        url: "https://github.com/acme/web-app/pull/120#discussion_r9001",
        reason: "no lasting rule in the thread",
      },
    ]);
  });

  test("a review PR a reviewer merged settles as merged, documents included", async () => {
    const t = team();
    await leeLearns(t.lee);
    await run([
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
    ]);
    await run(["sync", "--dir", t.lee]);
    const provider = new FakeProvider();
    await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    const branch = "homeostat/review-lee-2026-10-16";
    expect(provider.opened.map((o) => o.pr.sourceBranch)).toEqual([branch]);
    // The reviewer merges the review PR.
    t.g(t.ci, "fetch", "-q", "origin", branch);
    t.g(t.ci, "merge", "-q", "--no-edit", "FETCH_HEAD");
    t.g(t.ci, "push", "-q", "origin", "main");
    provider.open = [];
    provider.kbMerged = [branch];
    await run(["daily", "--dir", t.ci, "--no-reviews"], {
      provider,
      now: () => new Date("2026-10-17T06:00:00Z"),
    });
    const decided = JSON.parse(t.g(t.origin, "show", "homeostat/state:decisions/lee.json")).decided;
    expect(
      decided.map((d: { id: string; decision: string; reason: string }) => [
        d.id,
        d.decision,
        d.reason,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["use-the-shared-button-component", "merged", "merged by a reviewer"],
        ["knowledge/integrations/docs/partner-calls.md", "merged", "merged by a reviewer"],
      ]),
    );
  });

  test("one refused reviewer doesn't stop the others being asked", async () => {
    const t = team();
    await leeLearns(t.lee);
    // Two owners for frontend: dana (refused, as GitHub refuses a PR's own author) and sam.
    const config = join(t.ci, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "areas: [integrations, core]",
        "areas: [integrations, core, frontend]",
      ),
    );
    t.g(t.ci, "commit", "-qam", "dana owns frontend too");
    t.g(t.ci, "push", "-q", "origin", "main");
    const provider = new FakeProvider();
    provider.refuse = "dana";
    const { stdout } = await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(provider.reviewers.map((r) => r.logins)).toEqual([["sam"]]);
    expect(stdout).toContain("asked @sam to review");
    expect(stdout).toContain(
      "could not request @dana (Review cannot be requested from pull request author.)",
    );
  });
});

describe("homeostat daily in a multi-repo KB", { timeout: 30_000 }, () => {
  /** The multi-repo starter on a bare origin; the curator reads only repo web (acme/web-app). */
  function multiTeam() {
    const origin = mkdtempSync(join(tmpdir(), "homeostat-daily-multi-origin-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const ci = mkdtempSync(join(tmpdir(), "homeostat-daily-multi-ci-"));
    cpSync(new URL("../../../examples/starter-multi-kb", import.meta.url).pathname, ci, {
      recursive: true,
    });
    const config = join(ci, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8")
        .replace("host: bitbucket", "host: github")
        .replace("    repos: []", "    repos: [acme/integrations-api]"),
    );
    const retry = join(ci, "knowledge/api/integrations/outbound-http-retry-helper.md");
    writeFileSync(
      retry,
      readFileSync(retry, "utf8").replace(
        "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
        "https://github.com/acme/integrations-api/pull/812#discussion_r33",
      ),
    );
    const g = (...a: string[]) =>
      execFileSync(
        "git",
        ["-C", ci, "-c", "user.name=ci", "-c", "user.email=ci@example.com", ...a],
        {
          encoding: "utf8",
        },
      ).trim();
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-qm", "kb");
    g("remote", "add", "origin", origin);
    g("push", "-q", "origin", "main");
    return { origin, ci };
  }

  test("a review comment on repo web's PR becomes a rule under knowledge/web/", async () => {
    const t = multiTeam();
    const provider = new FakeProvider();
    const { code, stdout } = await run(["daily", "--dir", t.ci], { provider });
    expect(code).toBe(0);
    expect(stdout).toContain("lee: 1 merged");
    const daily = provider.opened[0]?.pr.sourceBranch ?? "";
    const show = (path: string) =>
      execFileSync("git", ["-C", t.origin, "show", `${daily}:${path}`], { encoding: "utf8" });
    const rule = show("knowledge/web/frontend/use-colour-tokens-instead-of-hex-values.md");
    expect(rule).toContain("area: frontend");
    expect(rule).toContain("apps/web/**");
  });
});

describe("homeostat daily in a topic KB", { timeout: 30_000 }, () => {
  /** The starter with topics, its retry rule moved into knowledge/integrations/http.md. */
  async function topicTeam() {
    const t = team();
    const config = join(t.ci, "homeostat.yaml");
    writeFileSync(
      config,
      `${readFileSync(config, "utf8")}\ntopics:\n  http: "Outbound HTTP calls to partners"\n  styling: "Colours, themes and component styles"\n`,
    );
    const path = "knowledge/integrations/outbound-http-retry-helper.md";
    const entry = parseEntry(readFileSync(join(t.ci, path), "utf8")).entry;
    if (!entry) throw new Error("starter rule");
    writeFileSync(
      join(t.ci, "knowledge/integrations/http.md"),
      formatTopicFile({ topic: "http", title: "HTTP" }, [
        { id: entry.frontmatter.id, raw: ruleSection(entry) },
      ]),
    );
    t.g(t.ci, "rm", "-q", path);
    t.g(t.ci, "add", "-A");
    t.g(t.ci, "commit", "-qm", "topics");
    t.g(t.ci, "push", "-q", "origin", "main");
    t.g(t.lee, "pull", "-q");
    return t;
  }

  test("a drafted lesson lands as a section of its topic file, and a suggestion is listed", async () => {
    const t = await topicTeam();
    const provider = new FakeProvider();
    const drafter = new FakeDrafter({ ...COLOUR_DRAFT, topic: "styling" });
    await run(["daily", "--dir", t.ci, "--dry-run"], { provider, drafter });
    const { code } = await run(["daily", "--dir", t.ci], { provider, drafter });
    expect(code).toBe(0);
    const branch = provider.opened[0]?.pr.sourceBranch ?? "";
    const styling = t.g(t.origin, "show", `${branch}:knowledge/frontend/styling.md`);
    expect(styling).toContain(
      "## Use colour tokens instead of hex values {#use-colour-tokens-instead-of-hex-values}",
    );
    expect(() => t.g(t.origin, "show", `${branch}:${DRAFTED}`)).toThrow();

    // A topic the drafter had to make up: the lesson goes to general, the PR says what it suggested.
    const t2 = await topicTeam();
    const p2 = new FakeProvider();
    await run(["daily", "--dir", t2.ci], {
      provider: p2,
      drafter: new FakeDrafter({ ...COLOUR_DRAFT, topic: "design-tokens" }),
    });
    const b2 = p2.opened[0];
    expect(
      t2.g(t2.origin, "show", `${b2?.pr.sourceBranch}:knowledge/frontend/general.md`),
    ).toContain("{#use-colour-tokens-instead-of-hex-values}");
    expect(b2?.pr.body).toContain("- `design-tokens`: `use-colour-tokens-instead-of-hex-values`");
  });

  test("a developer's flag on a rule in a topic file disputes it there, in place", async () => {
    const t = await topicTeam();
    await run([
      "flag",
      "outbound-http-retry-helper",
      "--dir",
      t.lee,
      "--reason",
      "withRetry moved",
      "--by",
      "lee",
    ]);
    await run(["sync", "--dir", t.lee]);
    const provider = new FakeProvider();
    const { stdout } = await run(["daily", "--dir", t.ci, "--no-reviews"], { provider });
    expect(stdout).toContain(
      "merged   outbound-http-retry-helper: a flag disputes the rule at once",
    );
    const branch = provider.opened[0]?.pr.sourceBranch ?? "";
    const http = t.g(t.origin, "show", `${branch}:knowledge/integrations/http.md`);
    expect(http).toContain("status: disputed");
    expect(() =>
      t.g(t.origin, "show", `${branch}:knowledge/integrations/outbound-http-retry-helper.md`),
    ).toThrow();
  });
});
