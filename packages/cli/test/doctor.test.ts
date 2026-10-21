import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;

/** The starter KB on GitHub, with a CI file running `homeostat@<version>`. */
function kb(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-doc-"));
  cpSync(starter, dir, { recursive: true });
  const config = join(dir, "homeostat.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("host: bitbucket", "host: github"));
  // GitHub URLs for the one pr-feedback entry, so the KB validates under the GitHub host.
  const entry = join(dir, "knowledge/integrations/outbound-http-retry-helper.md");
  writeFileSync(
    entry,
    readFileSync(entry, "utf8").replace(
      "https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33",
      "https://github.com/acme/integrations-api/pull/812#discussion_r33",
    ),
  );
  // GitHub reads CODEOWNERS from the root; the starter KB keeps it where Bitbucket reads it.
  renameSync(join(dir, ".bitbucket/CODEOWNERS"), join(dir, "CODEOWNERS"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".github/workflows/homeostat.yml"),
    `- run: npx --yes ${version} validate\n`,
  );
  // The deep-dive workflow names itself "homeostat deep-dive" twice; only the npx line runs it.
  writeFileSync(
    join(dir, ".github/workflows/homeostat-deep-dive.yml"),
    `name: homeostat deep-dive\n      - run: |\n          git config user.name "homeostat deep-dive"\n      - run: npx --yes ${version} deep-dive\n`,
  );
  return dir;
}

/** A GitHub API stub: answers by path, records whether each call carried the token. */
function github(routes: Record<string, unknown>, publicRepos: string[] = []) {
  const calls: { url: string; auth: boolean }[] = [];
  const fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    const auth = Boolean(init.headers.Authorization);
    calls.push({ url, auth });
    const path = url.replace("https://api.github.com/repos", "");
    if (!auth) return new Response("{}", { status: publicRepos.includes(path) ? 200 : 404 });
    const body = routes[path];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function doctor(dir: string, extra: Partial<Io>) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", "doctor", "--security", "--dir", dir], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: { GITHUB_TOKEN: "t" },
    ...extra,
  });
  return { code, stdout };
}

describe("homeostat doctor --security (T8)", () => {
  test("a well-set-up KB passes, and the report answers the four questions", async () => {
    const { fetch } = github({
      "/acme/team-kb/branches/main": { protected: true },
      "/acme/integrations-api": { permissions: { push: false } },
      "/acme/web-app": { permissions: { push: false } },
    });
    const { code, stdout } = await doctor(kb(`homeostat@${VERSION}`), { fetch });
    expect(code).toBe(0);
    for (const q of [
      "What does it read?",
      "What leaves your network?",
      "Who can change what agents are told?",
      "What if something is compromised?",
    ]) {
      expect(stdout).toContain(q);
    }
    expect(stdout).toContain("✓ main is protected on acme/team-kb");
    expect(stdout).toContain("✓ the token reads acme/web-app without write access");
    expect(stdout).toContain("✓ CI pins an exact homeostat version");
    expect(stdout).toContain("model calls go to Anthropic's Claude API");
    expect(stdout).toContain("✓ nobody shares usage counts");
    expect(stdout).toContain("· no homeostat on the PATH");
    expect(stdout).toContain("0 to fix");
  });

  test("members sharing usage counts are listed, and a homeostat on the PATH is checked against this version", async () => {
    const routes = {
      "/acme/team-kb/branches/main": { protected: true },
      "/acme/integrations-api": { permissions: { push: false } },
      "/acme/web-app": { permissions: { push: false } },
    };
    const dir = kb(`homeostat@${VERSION}`);
    const config = join(dir, "homeostat.yaml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace("    - id: lee\n", "    - id: lee\n      usage: true\n"),
    );
    const fake = (version: string) => {
      const bin = mkdtempSync(join(tmpdir(), "homeostat-doc-bin-"));
      writeFileSync(join(bin, "homeostat"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      return bin;
    };
    const old = await doctor(dir, {
      fetch: github(routes).fetch,
      env: { GITHUB_TOKEN: "t", PATH: fake("0.1.7") },
    });
    expect(old.stdout).toContain("usage counts shared in the heartbeat by: lee");
    expect(old.stdout).toContain(`! ${""}`.trimEnd());
    expect(old.stdout).toMatch(/! .*homeostat is 0\.1\.7, not /);
    const same = await doctor(dir, {
      fetch: github(routes).fetch,
      env: { GITHUB_TOKEN: "t", PATH: fake(VERSION) },
    });
    expect(same.stdout).toMatch(
      new RegExp(`✓ .*homeostat is ${VERSION.replace(/\./g, "\\.")}, the version running here`),
    );
  });

  test("an unprotected branch, an over-scoped token, a floating version and a public KB fail", async () => {
    // A floating range, built at runtime so the version test does not flag this file.
    const dir = kb(["homeostat", "0"].join("@"));
    rmSync(join(dir, "CODEOWNERS"), { force: true });
    rmSync(join(dir, ".github/CODEOWNERS"), { force: true });
    const { fetch } = github(
      {
        "/acme/team-kb/branches/main": { protected: false },
        "/acme/integrations-api": { permissions: { push: true } },
        "/acme/web-app": { permissions: { push: false } },
      },
      ["/acme/team-kb"],
    );
    const { code, stdout } = await doctor(dir, { fetch });
    expect(code).toBe(1);
    expect(stdout).toContain("✗ main is not protected on acme/team-kb");
    expect(stdout).toContain("✗ the token can write acme/integrations-api");
    expect(stdout).toContain(
      `✗ .github/workflows/homeostat.yml runs ${["homeostat", "0"].join("@")}:`,
    );
    expect(stdout).toContain("! the KB repo acme/team-kb is public");
    expect(stdout).toContain("! no CODEOWNERS file");
    // Once for the deep-dive workflow's npx line, never for its name or git user lines.
    expect(stdout.split("homeostat-deep-dive.yml runs").length - 1).toBe(1);
    expect(stdout).toContain("4 to fix, 2 to review");
  });

  test("a ruleset that requires pull requests counts as protection", async () => {
    const { fetch } = github({
      "/acme/team-kb/branches/main": { protected: false },
      "/acme/team-kb/rules/branches/main": [{ type: "pull_request" }, { type: "deletion" }],
    });
    const { stdout } = await doctor(kb(`homeostat@${VERSION}`), { fetch });
    expect(stdout).toContain("✓ main is protected by a ruleset on acme/team-kb");
    expect(stdout).not.toContain("main is not protected");
  });

  test("a private repo on a free plan is told that protection needs a paid plan", async () => {
    const base = github({ "/acme/team-kb/branches/main": { protected: false } });
    const fetch = (async (url: string, init: { headers: Record<string, string> }) =>
      url.endsWith("/rules/branches/main")
        ? new Response('{"message":"Upgrade to GitHub Pro or make this repository public"}', {
            status: 403,
          })
        : base.fetch(url, init as RequestInit)) as unknown as typeof globalThis.fetch;
    const { stdout } = await doctor(kb(`homeostat@${VERSION}`), { fetch });
    expect(stdout).toContain("main cannot be protected on acme/team-kb: GitHub protects branches");
  });

  test("the public check never sends the token", async () => {
    const { fetch, calls } = github({});
    await doctor(kb(`homeostat@${VERSION}`), { fetch });
    expect(calls.find((c) => c.url.endsWith("/acme/team-kb"))?.auth).toBe(false);
  });

  test("without a token it says what it could not check", async () => {
    const { fetch } = github({});
    const { stdout } = await doctor(kb(`homeostat@${VERSION}`), { fetch, env: {} });
    expect(stdout).toContain(
      "set HOMEOSTAT_GITHUB_TOKEN or GITHUB_TOKEN to check branch protection",
    );
  });
});

describe("homeostat doctor --security on Bitbucket", () => {
  /** The starter KB as committed: Bitbucket host, CODEOWNERS in .bitbucket/. */
  function bbKb() {
    const dir = mkdtempSync(join(tmpdir(), "homeostat-doc-bb-"));
    cpSync(starter, dir, { recursive: true });
    return dir;
  }

  /** A Bitbucket API stub: the KB repo's branch restrictions; every repo is private. */
  function bitbucket(
    restrictions: { kind: string; pattern: string; branch_match_kind?: string }[],
  ) {
    return (async (url: string, init: { headers: Record<string, string> }) => {
      if (!init.headers.Authorization) return new Response("{}", { status: 404 });
      if (url.includes("/repositories/acme/team-kb/branch-restrictions"))
        return Response.json({
          values: restrictions.map((r) => ({ branch_match_kind: "glob", ...r })),
        });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  }

  const run = (dir: string, fetch: typeof globalThis.fetch) =>
    doctor(dir, { fetch, env: { HOMEOSTAT_BITBUCKET_TOKEN: "t" } });

  test("enforced approvals on the base branch pass", async () => {
    const { stdout } = await run(
      bbKb(),
      bitbucket([
        { kind: "require_approvals_to_merge", pattern: "main" },
        { kind: "enforce_merge_checks", pattern: "main" },
      ]),
    );
    expect(stdout).toContain("✓ merges into main on acme/team-kb need an approval");
    expect(stdout).toContain("✓ CODEOWNERS routes each area to its reviewers");
  });

  test("approvals on another branch do not protect the base branch", async () => {
    const { stdout } = await run(
      bbKb(),
      bitbucket([
        { kind: "require_approvals_to_merge", pattern: "release/*" },
        { kind: "enforce_merge_checks", pattern: "release/*" },
      ]),
    );
    expect(stdout).toContain("merges into main on acme/team-kb need no approval");
  });

  test("approvals that are not enforced are only advice, short of Premium", async () => {
    const { stdout } = await run(
      bbKb(),
      bitbucket([{ kind: "require_approvals_to_merge", pattern: "*" }]),
    );
    expect(stdout).toContain("only Bitbucket Premium enforces merge checks");
  });

  test("a root CODEOWNERS is ignored by Bitbucket", async () => {
    const dir = bbKb();
    renameSync(join(dir, ".bitbucket/CODEOWNERS"), join(dir, "CODEOWNERS"));
    const { stdout } = await run(dir, bitbucket([]));
    expect(stdout).toContain("Bitbucket reads CODEOWNERS only from .bitbucket/");
  });
});
