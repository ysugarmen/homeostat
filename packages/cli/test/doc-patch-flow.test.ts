import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSections,
  type DocCandidate,
  type DocPatcher,
  type DocProposal,
  type Drafter,
  type NewPullRequest,
  type Provider,
  type PullRequest,
  type RepoRef,
  type ReviewThread,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const DOC = "knowledge/integrations/docs/partner-calls.md";

function kbRepo() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-dp-"));
  cpSync(starter, dir, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  const origin = mkdtempSync(join(tmpdir(), "homeostat-dp-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "ci");
  git("config", "user.email", "ci@example.com");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  return { dir, git };
}

/** A merged PR in integrations-api where a reviewer renames the shared client package. */
class RenameProvider {
  readonly kind = "bitbucket" as const;
  opened: NewPullRequest[] = [];
  merged: number[] = [];
  async listMergedPullRequests(repo: RepoRef): Promise<PullRequest[]> {
    if (repo.name !== "integrations-api") return [];
    return [
      {
        id: 901,
        title: "Move to the renamed network package",
        url: "https://bitbucket.org/acme/integrations-api/pull-requests/901",
        author: { id: "lee" },
        mergedAt: "2026-10-12T10:00:00Z",
        sourceBranch: "f",
        targetBranch: "main",
      },
    ];
  }
  async listOpenPullRequests() {
    return [];
  }
  async listReviewComments() {
    return [
      {
        id: 5,
        body: "@acme/http-client was renamed to @acme/net last week; import withRetry() from @acme/net.",
        author: { id: "sam" },
        createdAt: "2026-10-11T15:00:00Z",
        url: "https://bitbucket.org/acme/integrations-api/pull-requests/901#comment-5",
        path: "services/integrations/partner.ts",
      },
    ];
  }
  async listCommits() {
    return [{ sha: "a", date: "2026-10-11T16:00:00Z", message: "use @acme/net" }];
  }
  async openPullRequest(_r: unknown, pr: NewPullRequest) {
    this.opened.push(pr);
    return { id: 7, url: "https://bitbucket.org/acme/team-kb/pull-requests/7" };
  }
  async mergePullRequest(_r: unknown, id: number) {
    this.merged.push(id);
  }
}

const noRule: Drafter = { draft: async () => null };

/** Stands in for the model: renames the package in the one section that mentions it. */
class RenamePatcher implements DocPatcher {
  seen: DocCandidate[][] = [];
  async propose(_t: ReviewThread, docs: readonly DocCandidate[]): Promise<DocProposal | null> {
    this.seen.push([...docs]);
    const section = docs[0]?.sections.find((s) => s.body.includes("@acme/http-client"));
    if (!section || !docs[0]) return null;
    return {
      path: docs[0].path,
      sectionId: section.id,
      op: "replace",
      body: section.body.replace("@acme/http-client", "@acme/net"),
      reason: "the shared client package was renamed to @acme/net",
    };
  }
}

async function curate(dir: string, extra: Partial<Io>) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", "curate", "--dir", dir], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: { HOMEOSTAT_BITBUCKET_TOKEN: "t" },
    now: () => new Date("2026-10-13T06:00:00Z"),
    ...extra,
  });
  return { code, stdout };
}

describe("agents keep documents current (K4)", () => {
  test("a review thread that renames a package becomes a one-section patch in the review PR", async () => {
    const { dir, git } = kbRepo();
    const provider = new RenameProvider();
    const patcher = new RenamePatcher();
    const before = readFileSync(join(dir, DOC), "utf8");
    const { code, stdout } = await curate(dir, {
      provider: provider as unknown as Provider,
      drafter: noRule,
      patcher,
    });
    expect(code).toBe(0);
    expect(stdout).toContain(`~ ${DOC} (#http-client)`);
    expect(patcher.seen[0]?.map((d) => d.path)).toEqual([DOC]);

    expect(provider.merged).toEqual([]); // documents never auto-merge
    expect(provider.opened).toHaveLength(1);
    const pr = provider.opened[0];
    expect(pr?.title).toBe("homeostat: 1 document update from review feedback");
    expect(pr?.body).toContain(`\`${DOC}#http-client\`: the shared client package was renamed`);

    const after = git("show", `${pr?.sourceBranch}:${DOC}`);
    expect(changedSections(before, after)).toEqual(["http-client"]);
    expect(after).toContain("from `@acme/net`");
    expect(after).toContain(
      "<!-- homeostat: source=curator url=https://bitbucket.org/acme/integrations-api/pull-requests/901#comment-5 updated=2026-10-13 -->",
    );
    // Everything else in the file is untouched.
    const strip = (t: string) =>
      t
        .trimEnd()
        .replace(/updated: .*/, "")
        .replace(/## The shared HTTP client[\s\S]*?(?=\n## )/, "");
    expect(strip(after)).toBe(strip(before));
    expect(
      (
        await runCli(["node", "homeostat", "validate", dir], {
          stdout() {},
          stderr() {},
          color: false,
        })
      ).valueOf(),
    ).toBe(0);
  });

  test("a thread on a file no document covers is never shown to the patcher", async () => {
    const { dir } = kbRepo();
    const provider = new RenameProvider();
    provider.listReviewComments = async () => [
      {
        id: 6,
        body: "Rename this.",
        author: { id: "sam" },
        createdAt: "2026-10-11T15:00:00Z",
        url: "https://bitbucket.org/acme/integrations-api/pull-requests/901#comment-6",
        path: "apps/web/src/Button.tsx",
      },
    ];
    const patcher = new RenamePatcher();
    await curate(dir, { provider: provider as unknown as Provider, drafter: noRule, patcher });
    expect(patcher.seen).toEqual([]);
  });

  test("a proposal for a section that does not exist is skipped with the reason", async () => {
    const { dir } = kbRepo();
    const provider = new RenameProvider();
    const patcher: DocPatcher = {
      propose: async () => ({
        path: DOC,
        sectionId: "nope",
        op: "replace",
        body: "x",
        reason: "r",
      }),
    };
    const { stdout } = await curate(dir, {
      provider: provider as unknown as Provider,
      drafter: noRule,
      patcher,
    });
    expect(stdout).toContain(`document patch: no section ${DOC}#nope`);
    expect(provider.opened).toEqual([]);
  });
});

describe("learn --doc (K4)", () => {
  async function learn(dir: string, args: string[]) {
    let out = "";
    const code = await runCli(
      ["node", "homeostat", "learn", "--dir", dir, "--author", "dana", ...args],
      {
        stdout: (s) => (out += s),
        stderr: (s) => (out += s),
        color: false,
        env: {},
        now: () => new Date("2026-10-14T09:00:00Z"),
      },
    );
    return { code, out };
  }
  const doc = ["--doc", "integrations/partner-calls"];

  test("replaces, appends to and adds sections, one at a time", async () => {
    const { dir } = kbRepo();
    const before = readFileSync(join(dir, DOC), "utf8");
    const r = await learn(dir, [
      ...doc,
      "--section",
      "timeouts",
      "--append",
      "--text",
      "Refunds wait 30 seconds too.",
    ]);
    expect(r.code, r.out).toBe(0);
    const appended = readFileSync(join(dir, DOC), "utf8");
    expect(changedSections(before, appended)).toEqual(["timeouts"]);
    expect(appended).toContain("<!-- homeostat: source=manual author=dana updated=2026-10-14 -->");

    await learn(dir, [
      ...doc,
      "--section",
      "webhooks",
      "--heading",
      "Partner webhooks",
      "--text",
      "They land on /hooks.",
    ]);
    expect(changedSections(appended, readFileSync(join(dir, DOC), "utf8"))).toEqual(["webhooks"]);
  });

  test("on a branch it patches the branch's copy, keeping earlier patches", async () => {
    const { dir, git } = kbRepo();
    await learn(dir, [
      ...doc,
      "--section",
      "timeouts",
      "--append",
      "--text",
      "First.",
      "--branch",
      "candidates/dana",
    ]);
    await learn(dir, [
      ...doc,
      "--section",
      "http-client",
      "--append",
      "--text",
      "Second.",
      "--branch",
      "candidates/dana",
    ]);
    const onBranch = git("show", `candidates/dana:${DOC}`);
    expect(onBranch).toContain("First.");
    expect(onBranch).toContain("Second.");
    expect(readFileSync(join(dir, DOC), "utf8")).not.toContain("First."); // working tree untouched
  });

  test("an unknown section or document is refused", async () => {
    const { dir } = kbRepo();
    expect((await learn(dir, [...doc, "--section", "nope", "--text", "x"])).out).toContain(
      'no section with id "nope"',
    );
    expect(
      (await learn(dir, ["--doc", "core/nothing", "--section", "a", "--text", "x"])).out,
    ).toContain("no document at knowledge/core/docs/nothing.md");
  });
});
