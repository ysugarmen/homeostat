import { describe, expect, test } from "vitest";
import { BitbucketProvider } from "../../src/providers/bitbucket.ts";
import { GitHubProvider } from "../../src/providers/github.ts";
import { replayFetch } from "./replay.ts";

const kb = { owner: "acme", name: "team-kb" };

function bitbucket() {
  const replay = replayFetch("bitbucket");
  return { ...replay, bb: new BitbucketProvider({ token: "test-token", fetch: replay.fetch }) };
}

function github() {
  const replay = replayFetch("github");
  return { ...replay, gh: new GitHubProvider({ token: "test-token", fetch: replay.fetch }) };
}

describe("BitbucketProvider setup calls", () => {
  test("lists workspace members by nickname, across pages", async () => {
    const { bb } = bitbucket();
    const members = await bb.listMembers(kb);
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(m.id).not.toMatch(/^\{|^\d+:/);
    expect(members).toContainEqual({ id: "dana", name: "Dana Reyes" });
  });

  test("reads a repository's main branch", async () => {
    const { bb } = bitbucket();
    expect(await bb.getRepository(kb)).toEqual({
      fullName: "acme/team-kb",
      defaultBranch: "main",
      private: true,
    });
  });

  test("probes a repo's pull requests with one item", async () => {
    const { bb, sent } = bitbucket();
    await bb.probePullRequests({ owner: "acme", name: "integrations-api" });
    expect(sent[0]?.url).toContain("pullrequests?pagelen=1");
  });

  test("lists the top-level folders of a branch", async () => {
    const { bb } = bitbucket();
    expect(await bb.topLevelFolders({ owner: "acme", name: "integrations-api" }, "main")).toEqual([
      "services",
      "apps",
    ]);
  });

  test("lists repository variables without values", async () => {
    const { bb } = bitbucket();
    const vars = await bb.listVariables(kb);
    expect(vars).toEqual([
      {
        uuid: "{6f1d2c3b-0000-4000-8000-000000000001}",
        key: "HOMEOSTAT_BITBUCKET_TOKEN",
        secured: true,
      },
      {
        uuid: "{6f1d2c3b-0000-4000-8000-000000000002}",
        key: "HOMEOSTAT_BITBUCKET_EMAIL",
        secured: false,
      },
    ]);
  });

  test("updates an existing variable by its uuid", async () => {
    const { bb, sent } = bitbucket();
    await bb.setVariable(kb, "HOMEOSTAT_BITBUCKET_TOKEN", "fixture-secret", true);
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.url).toContain("/pipelines_config/variables/%7B6f1d2c3b");
    expect(put?.body).toMatchObject({ key: "HOMEOSTAT_BITBUCKET_TOKEN", secured: true });
    expect(sent.some((s) => s.method === "POST")).toBe(false);
  });

  test("creates a variable that does not exist yet", async () => {
    const { bb, sent } = bitbucket();
    await bb.setVariable(kb, "ANTHROPIC_API_KEY", "fixture-secret", true);
    const post = sent.find((s) => s.method === "POST");
    expect(post?.url).toMatch(/\/pipelines_config\/variables\/$/);
    expect(post?.body).toEqual({
      key: "ANTHROPIC_API_KEY",
      value: "fixture-secret",
      secured: true,
    });
  });

  test("lists schedules with their custom pipeline", async () => {
    const { bb } = bitbucket();
    expect(await bb.listSchedules(kb)).toEqual([
      {
        uuid: "{9a8b7c6d-0000-4000-8000-000000000001}",
        pipeline: "homeostat-curator",
        branch: "main",
        cron: "0 0 6 * * ? *",
        enabled: false,
      },
    ]);
  });

  test("creates a schedule for a custom pipeline", async () => {
    const { bb, sent } = bitbucket();
    await bb.createSchedule(kb, {
      pipeline: "homeostat-deep-dive",
      branch: "main",
      cron: "0 0 7 ? * MON *",
    });
    expect(sent[0]?.body).toMatchObject({
      target: { selector: { type: "custom", pattern: "homeostat-deep-dive" }, ref_name: "main" },
    });
  });

  test("enables a disabled schedule", async () => {
    const { bb, sent } = bitbucket();
    await bb.enableSchedule(kb, "{9a8b7c6d-0000-4000-8000-000000000001}");
    expect(sent[0]?.method).toBe("PUT");
  });
});

describe("GitHubProvider setup calls", () => {
  test("lists an org's members across pages", async () => {
    const { gh } = github();
    expect(await gh.listMembers(kb)).toEqual([{ id: "dana" }, { id: "lee" }, { id: "sam" }]);
  });

  test("falls back to collaborators for a user's repo", async () => {
    const { gh } = github();
    expect(await gh.listMembers({ owner: "ada", name: "notes" })).toEqual([{ id: "ada" }]);
  });

  test("reads a repository's default branch and push access", async () => {
    const { gh } = github();
    expect(await gh.getRepository(kb)).toEqual({
      fullName: "acme/team-kb",
      defaultBranch: "main",
      private: true,
      canWrite: true,
    });
  });

  test("probes pull requests, and lists top-level folders", async () => {
    const { gh } = github();
    const repo = { owner: "acme", name: "web-app" };
    await gh.probePullRequests(repo);
    expect(await gh.topLevelFolders(repo, "main")).toEqual(["apps", "packages"]);
  });

  test("lists Actions secret names and whether Actions run", async () => {
    const { gh } = github();
    expect(await gh.listSecretNames(kb)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(await gh.actionsEnabled(kb)).toBe(true);
  });
});
