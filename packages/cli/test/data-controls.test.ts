import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Draft,
  type Drafter,
  draftSchema,
  logEvent,
  type Provider,
  type PullRequest,
  parseConfig,
  pruneEvents,
  type RepoRef,
  type ReviewComment,
  type ReviewThread,
  readEvents,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { askerFor } from "../src/agents.ts";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

/** The starter KB (Bitbucket; repos acme/integrations-api and acme/web-app), with config edits. */
function kb(edit: (yaml: string) => string = (y) => y) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-t5-"));
  cpSync(starter, dir, { recursive: true });
  const path = join(dir, "homeostat.yaml");
  writeFileSync(path, edit(readFileSync(path, "utf8")));
  return dir;
}

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: 120,
  title: "Retry partner calls",
  url: "https://bitbucket.org/acme/web-app/pull-requests/120",
  author: { id: "lee" },
  mergedAt: "2026-10-12T10:00:00Z",
  sourceBranch: "f",
  targetBranch: "main",
  ...over,
});

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 9001,
  body: "Wrap this call in withRetry().",
  author: { id: "sam" },
  createdAt: "2026-10-11T15:00:00Z",
  url: "https://bitbucket.org/acme/web-app/pull-requests/120#comment-9001",
  path: "services/integrations/partner.ts",
  ...over,
});

/** Records which repos were listed and what reached the drafter. */
function fakes(prs: PullRequest[], comments: ReviewComment[]) {
  const listed: string[] = [];
  const drafted: ReviewThread[] = [];
  const provider = {
    kind: "bitbucket",
    async listMergedPullRequests(repo: RepoRef) {
      listed.push(`${repo.owner}/${repo.name}`);
      return repo.name === "web-app" ? prs : [];
    },
    async listOpenPullRequests() {
      return [];
    },
    async listReviewComments() {
      return comments;
    },
    async listCommits() {
      return [{ sha: "a", date: "2026-10-11T16:00:00Z", message: "retry" }];
    },
  } as unknown as Provider;
  const drafter: Drafter = {
    async draft(t: ReviewThread): Promise<Draft | null> {
      drafted.push(t);
      return null;
    },
  };
  return { provider, drafter, listed, drafted };
}

async function curate(dir: string, extra: Partial<Io>, args: string[] = ["--dry-run"]) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", "curate", "--dir", dir, ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: { HOMEOSTAT_BITBUCKET_TOKEN: "t" },
    now: () => new Date("2026-10-13T06:00:00Z"),
    ...extra,
  });
  return { code, stdout };
}

describe("data controls (T5): what the curator never reads or sends", () => {
  test("a PR marked homeostat:skip is not read", async () => {
    const f = fakes([pr({ skipRequested: true })], [comment()]);
    const { stdout } = await curate(kb(), f);
    expect(f.drafted).toEqual([]);
    expect(stdout).toContain("marked homeostat:skip");
  });

  test("an opted-out member's PRs and review comments are not read", async () => {
    const dir = kb((y) => y.replace('handle: "@lee"', 'handle: "@lee"\n      optOut: true'));
    const byLee = fakes([pr()], [comment()]);
    expect((await curate(dir, byLee)).stdout).toContain("the author opted out");
    expect(byLee.drafted).toEqual([]);

    const reviewedByLee = fakes(
      [pr({ author: { id: "dana" } })],
      [comment({ author: { id: "lee" } })],
    );
    expect((await curate(dir, reviewedByLee)).stdout).toContain("the reviewer opted out");
    expect(reviewedByLee.drafted).toEqual([]);
  });

  test("excluded repos are never listed and excluded paths never drafted", async () => {
    const dir = kb((y) =>
      y.replace(
        "    repos: []\n    paths: []",
        '    repos: [acme/integrations-api]\n    paths: ["services/integrations/**"]',
      ),
    );
    const f = fakes([pr()], [comment()]);
    const { stdout } = await curate(dir, f);
    expect(f.listed).toEqual(["acme/web-app"]);
    expect(f.drafted).toEqual([]);
    expect(stdout).toContain("the file is in sources.exclude.paths");
  });

  test("--show-prompts prints exactly what would be sent, calls no model, commits nothing", async () => {
    const f = fakes([pr()], [comment()]);
    const neverCalled: Drafter = {
      draft: async () => {
        throw new Error("a model was called");
      },
    };
    const { code, stdout } = await curate(kb(), { ...f, drafter: neverCalled }, ["--show-prompts"]);
    expect(code).toBe(0);
    expect(stdout).toContain("--- system prompt (sent with every thread) ---");
    expect(stdout).toContain(
      "--- prompt for https://bitbucket.org/acme/web-app/pull-requests/120#comment-9001 ---",
    );
    expect(stdout).toContain("sam: Wrap this call in withRetry().");
    expect(stdout).toContain("prompt shown above; nothing sent");
    expect(stdout).not.toContain("no lasting rule");
    expect(stdout).toContain("dry run: nothing committed");
  });
});

describe("model-call events", () => {
  test("record the agent, runtime, model and size, never the content", async () => {
    const dir = kb();
    const { config } = parseConfig(readFileSync(join(dir, "homeostat.yaml"), "utf8"));
    if (!config) throw new Error("bad config");
    const ask = askerFor(
      config,
      "curator",
      { stdout() {}, stderr() {}, color: false, env: {} },
      dir,
    );
    await expect(ask("SYSTEM-SECRET-TEXT", "USER-TEXT", draftSchema)).rejects.toThrow();
    const [e] = readEvents(dir, { types: ["model-call"] });
    expect(e).toMatchObject({ agent: "curator", runtime: "api", chars: 27, ok: false });
    expect(JSON.stringify(e)).not.toContain("SECRET");
  });
});

describe("event retention", () => {
  test("pruneEvents deletes events older than the window", () => {
    const dir = kb();
    logEvent(dir, { ts: "2026-06-01T00:00:00Z", type: "injection" });
    logEvent(dir, { ts: "2026-10-10T00:00:00Z", type: "injection" });
    expect(pruneEvents(dir, 90, new Date("2026-10-14T00:00:00Z"))).toBe(1);
    expect(readEvents(dir).map((e) => e.ts)).toEqual(["2026-10-10T00:00:00Z"]);
  });
});
