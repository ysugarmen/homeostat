import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const RULE = "outbound-http-retry-helper"; // area integrations; dana is a member, lee is not

/** The starter KB with integrations team-only. */
function kb() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-vis-"));
  cpSync(starter, dir, { recursive: true });
  const config = join(dir, "homeostat.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "  allowedDomains: []\n",
      "  allowedDomains: []\n  teamOnlyAreas: [integrations]\n",
    ),
  );
  return dir;
}

/** A code repo whose origin is on GitHub, committed as `user`, with one changed file. */
function codeRepo(user: string, origin = "git@github.com:acme/web-app.git") {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-vis-code-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a]);
  git("init", "-q");
  git("config", "user.name", user);
  git("remote", "add", "origin", origin);
  const file = join(dir, "services/integrations/partner.ts");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "x");
  return dir;
}

/** Everything export wrote into `dir`, outside .git and the source file. */
function exported(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.parentPath.includes(".git") && !d.name.endsWith(".ts"))
    .map((d) => readFileSync(join(d.parentPath, d.name), "utf8"))
    .join("\n");
}

async function run(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["node", "homeostat", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    color: false,
    env: {},
    ...extra,
  });
  return { code, stdout, stderr };
}

/** A git host that says every repo is public (200) or private (404), and records the asks. */
function host(status: number) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    return new Response("{}", { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("team-only areas (T7)", () => {
  test("reach their members' sessions and nobody else's", async () => {
    const kbDir = kb();
    const session = async (user: string) => {
      const cwd = codeRepo(user);
      const { stdout } = await run(["hook", "session-start"], {
        env: { HOMEOSTAT_DIR: kbDir },
        stdin: async () => JSON.stringify({ session_id: "s", cwd }),
      });
      return stdout;
    };
    expect(await session("Dana")).toContain(RULE);
    expect(await session("Lee")).not.toContain(RULE);
    expect(await session("Someone Else")).not.toContain(RULE);
  });

  test("are never exported, even into a private repo", async () => {
    const out = codeRepo("Dana");
    const { code } = await run(["export", "--kb", kb(), "--out", out], host(404));
    expect(code).toBe(0);
    const files = exported(out);
    expect(files).toContain("redact-before-logging");
    expect(files).not.toContain(RULE);
  });
});

describe("export into a public repo (T7)", () => {
  test("is refused unless --allow-public, and writes nothing", async () => {
    const out = codeRepo("Dana", "https://github.com/acme/open-source.git");
    const h = host(200);
    const refused = await run(["export", "--kb", kb(), "--out", out], h);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("acme/open-source is public");
    expect(h.asked).toEqual(["https://api.github.com/repos/acme/open-source"]);
    expect(exported(out)).toBe("");

    const allowed = await run(["export", "--kb", kb(), "--out", out, "--allow-public"], h);
    expect(allowed.code).toBe(0);
    expect(exported(out)).toContain("redact-before-logging");
    expect(exported(out)).not.toContain(RULE);
  });

  test("Bitbucket repos are checked the same way", async () => {
    const out = codeRepo("Dana", "git@bitbucket.org:acme/site.git");
    const h = host(200);
    expect((await run(["export", "--kb", kb(), "--out", out], h)).code).toBe(1);
    expect(h.asked).toEqual(["https://api.bitbucket.org/2.0/repositories/acme/site"]);
  });

  test("when the host cannot be reached, it says so and exports", async () => {
    const out = codeRepo("Dana");
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { code, stderr } = await run(["export", "--kb", kb(), "--out", out], { fetch: offline });
    expect(code).toBe(0);
    expect(stderr).toContain("could not check whether acme/web-app is public");
  });
});

test("a team-only area must be a configured area", async () => {
  const dir = kb();
  const config = join(dir, "homeostat.yaml");
  writeFileSync(config, readFileSync(config, "utf8").replace("[integrations]", "[core]"));
  const { code, stdout } = await run(["validate", dir]);
  expect(code).toBe(1);
  expect(stdout).toContain("core reaches everyone by definition");
});
