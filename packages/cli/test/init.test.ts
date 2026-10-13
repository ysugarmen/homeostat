import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@kbx/core";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { readKbFiles } from "../src/files.ts";

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "kbx", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
  });
  return { code, stdout, stderr };
}

/** An empty git repo, optionally with an origin remote. */
function repo(remote?: string) {
  const dir = mkdtempSync(join(tmpdir(), "kbx-init-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q");
  git("config", "user.name", "Ada Lovelace");
  if (remote) git("remote", "add", "origin", remote);
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("kbx init", () => {
  test("on an empty repo leaves a valid KB behind", async () => {
    const dir = repo();
    const { code, stdout } = await run("init", dir);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "kbx.yaml"))).toBe(true);
    expect(existsSync(join(dir, "knowledge/core/.gitkeep"))).toBe(true);
    expect(validate(readKbFiles(dir)).ok).toBe(true);
    expect(stdout).toContain("✓ knowledge base is valid");
  });

  test("seeds the first member from git user.name as a senior", async () => {
    const dir = repo();
    await run("init", dir);
    const config = read(dir, "kbx.yaml");
    expect(config).toContain("- id: ada-lovelace");
    expect(config).toContain("role: senior");
    expect(config).toContain('# handle: "@your-user"');
  });

  test("--member and --handle override the seed member", async () => {
    const dir = repo();
    await run("init", dir, "--member", "ada", "--handle", "@ada");
    const config = read(dir, "kbx.yaml");
    expect(config).toContain("- id: ada");
    expect(config).toContain('handle: "@ada"');
  });

  test("without a remote it skips CI and says how to add it", async () => {
    const dir = repo();
    const { stdout } = await run("init", dir);
    expect(existsSync(join(dir, ".github"))).toBe(false);
    expect(existsSync(join(dir, "bitbucket-pipelines.yml"))).toBe(false);
    expect(stdout).toContain("could not detect the git host");
    expect(stdout).toContain("--host github|bitbucket");
  });

  test.each([["git@github.com:acme/team-kb.git"], ["https://github.com/acme/team-kb.git"]])(
    "detects GitHub from %s and writes a workflow",
    async (remote) => {
      const dir = repo(remote);
      const { code, stdout } = await run("init", dir);
      expect(code).toBe(0);
      const workflow = read(dir, ".github/workflows/kbx.yml");
      expect(workflow).toContain("pull_request:");
      expect(workflow).toContain("npx --yes kbx@0 validate");
      expect(stdout).toContain("Git host: GitHub (from the origin remote)");
      expect(stdout).toContain("KBX_GITHUB_TOKEN");
    },
  );

  test.each([
    ["git@bitbucket.org:acme/team-kb.git"],
    ["https://ada@bitbucket.org/acme/team-kb.git"],
  ])("detects Bitbucket from %s and writes a pipeline", async (remote) => {
    const dir = repo(remote);
    const { code, stdout } = await run("init", dir);
    expect(code).toBe(0);
    const pipeline = read(dir, "bitbucket-pipelines.yml");
    expect(pipeline).toContain("pull-requests:");
    expect(pipeline).toContain("npx --yes kbx@0 validate");
    expect(stdout).toContain("Git host: Bitbucket (from the origin remote)");
    expect(stdout).toContain("pullrequest:write");
    expect(stdout).toContain("KBX_BITBUCKET_TOKEN");
  });

  test("--host overrides detection", async () => {
    const dir = repo("git@github.com:acme/team-kb.git");
    const { stdout } = await run("init", dir, "--host", "bitbucket");
    expect(existsSync(join(dir, "bitbucket-pipelines.yml"))).toBe(true);
    expect(existsSync(join(dir, ".github"))).toBe(false);
    expect(stdout).toContain("Git host: Bitbucket (from --host)");
  });

  test("an unknown --host is rejected", async () => {
    const { code, stderr } = await run("init", repo(), "--host", "gitlab");
    expect(code).toBe(1);
    expect(stderr).toContain("gitlab");
  });

  test("refuses to overwrite an existing kbx.yaml without --force", async () => {
    const dir = repo();
    writeFileSync(join(dir, "kbx.yaml"), "mine\n");
    const refused = await run("init", dir);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain("kbx.yaml already exists; use --force to overwrite");
    expect(read(dir, "kbx.yaml")).toBe("mine\n");

    expect((await run("init", dir, "--force")).code).toBe(0);
    expect(read(dir, "kbx.yaml")).toContain("version: 1");
  });

  test("never overwrites an existing CI file, and says what to add instead", async () => {
    const dir = repo("git@bitbucket.org:acme/team-kb.git");
    writeFileSync(join(dir, "bitbucket-pipelines.yml"), "image: node:24\n");
    const { code, stdout } = await run("init", dir, "--force");
    expect(code).toBe(0);
    expect(read(dir, "bitbucket-pipelines.yml")).toBe("image: node:24\n");
    expect(stdout).toContain("bitbucket-pipelines.yml already exists; add this to it");
  });

  test("an invalid handle writes nothing", async () => {
    const dir = repo();
    const { code, stdout } = await run("init", dir, "--handle", "ada");
    expect(code).toBe(1);
    expect(stdout).toContain("handle must be @user, @org/team or an email");
    expect(stdout).toContain("nothing written");
    expect(existsSync(join(dir, "kbx.yaml"))).toBe(false);
    expect(existsSync(join(dir, "knowledge"))).toBe(false);
  });

  test("keeps existing entries", async () => {
    const dir = repo();
    mkdirSync(join(dir, "knowledge/core"), { recursive: true });
    writeFileSync(join(dir, "knowledge/core/.gitkeep"), "keep");
    await run("init", dir);
    expect(read(dir, "knowledge/core/.gitkeep")).toBe("keep");
  });
});

describe("planned commands", () => {
  test.each([
    ["export", "2.7"],
    ["up", "2.5"],
    ["status", "4.3"],
  ])("kbx %s says which step builds it", async (command, step) => {
    const { code, stderr } = await run(command);
    expect(code).toBe(1);
    expect(stderr).toContain(`kbx ${command} is not built yet (execution plan step ${step})`);
  });
});

describe("kbx init .gitignore", () => {
  test("ignores the local .kbx/ event log", async () => {
    const dir = repo();
    await run("init", dir);
    expect(read(dir, ".gitignore")).toBe(".kbx/\n");
  });

  test("appends to an existing .gitignore once", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "node_modules");
    await run("init", dir);
    await run("init", dir, "--force");
    expect(read(dir, ".gitignore")).toBe("node_modules\n.kbx/\n");
  });
});

describe("kbx init curator schedule", () => {
  test("GitHub gets a scheduled curator workflow with write access", async () => {
    const dir = repo("git@github.com:acme/team-kb.git");
    await run("init", dir);
    const workflow = read(dir, ".github/workflows/kbx-curator.yml");
    expect(workflow).toContain('- cron: "0 6 * * *"');
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("npx --yes kbx@0 curate");
    expect(workflow).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
  });

  test("Bitbucket gets a custom curator pipeline and is told where to schedule it", async () => {
    const dir = repo("git@bitbucket.org:acme/team-kb.git");
    const { stdout } = await run("init", dir);
    const pipeline = read(dir, "bitbucket-pipelines.yml");
    expect(pipeline).toContain("kbx-curator:");
    expect(pipeline).toContain("depth: full");
    expect(stdout).toContain("Repository settings > Pipelines > Schedules");
  });
});
