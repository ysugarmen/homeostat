import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type NewPullRequest,
  type Provider,
  parseDoc,
  type RepoSnapshot,
  type SeedDraft,
  type Seeder,
  type SeedTopic,
  snapshotRepo,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const TOKEN = ["ghp_", "Z".repeat(18), "y".repeat(18)].join("");

/** A small code repo: a README, a manifest, source files, and a secret in a config file. */
function codeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-seed-repo-"));
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  };
  put("README.md", "# Partner gateway\nRoutes partner calls through services/integrations.\n");
  put("package.json", JSON.stringify({ name: "partner-gateway", scripts: { test: "vitest" } }));
  put("services/integrations/client.ts", "export const call = () => 1;\n");
  put("services/integrations/secrets/keys.ts", "export const k = 1;\n");
  put("docker-compose.yml", `services:\n  api:\n    environment:\n      GITHUB_TOKEN: ${TOKEN}\n`);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

function kb(extraConfig = "") {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-seed-kb-"));
  cpSync(starter, dir, { recursive: true });
  const config = join(dir, "homeostat.yaml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "    paths: []",
      `    paths: ["**/secrets/**"]${extraConfig}`,
    ),
  );
  return dir;
}

class FakeSeeder implements Seeder {
  seen: { snapshot: RepoSnapshot; topic: SeedTopic }[] = [];
  async draft(snapshot: RepoSnapshot, topic: SeedTopic): Promise<SeedDraft> {
    this.seen.push({ snapshot, topic });
    return {
      title: `Partner gateway ${topic}`,
      intro: "What the partner gateway is made of.",
      sections: [
        {
          heading: "Services",
          body: "Partner calls go through services/integrations/client.ts.",
          confidence: "high",
        },
        { heading: "Testing", body: "Tests run with vitest (npm test).", confidence: "medium" },
      ],
    };
  }
}

async function seed(args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", "seed", ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-14T09:00:00Z"),
    ...extra,
  });
  return { code, stdout };
}

describe("snapshotRepo", () => {
  test("keeps exclusions out, picks key files and redacts secrets", () => {
    const repo = codeRepo();
    const tracked = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const snap = snapshotRepo("gw", tracked, (p) => readFileSync(join(repo, p), "utf8"), [
      "**/secrets/**",
    ]);
    expect(snap.paths).not.toContain("services/integrations/secrets/keys.ts");
    expect(snap.files.map((f) => f.path)).toEqual([
      "README.md",
      "docker-compose.yml",
      "package.json",
    ]);
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
    expect(snap.redacted).toBe(1);
  });
});

describe("homeostat seed (K5)", () => {
  test("--dry-run prints what would be sent and sends nothing", async () => {
    const seeder = new FakeSeeder();
    const dir = kb();
    const { code, stdout } = await seed(
      [codeRepo(), "--area", "integrations", "--owner", "dana", "--dir", dir, "--dry-run"],
      { seeder },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("--- prompt for architecture ---");
    expect(stdout).toContain('<file path="README.md">');
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).toContain("dry run: nothing sent, nothing written");
    expect(seeder.seen).toEqual([]);
    expect(existsSync(join(dir, "knowledge/integrations/docs/architecture.md"))).toBe(false);
  });

  test("writes valid documents with seed provenance on every section", async () => {
    const dir = kb();
    const seeder = new FakeSeeder();
    const { code, stdout } = await seed(
      [codeRepo(), "--area", "integrations", "--owner", "dana", "--dir", dir],
      { seeder },
    );
    expect(code, stdout).toBe(0);
    expect(seeder.seen.map((s) => s.topic)).toEqual(["architecture", "conventions"]);
    for (const topic of ["architecture", "conventions"]) {
      const { doc, issues } = parseDoc(
        readFileSync(join(dir, `knowledge/integrations/docs/${topic}.md`), "utf8"),
      );
      expect(issues).toEqual([]);
      expect(doc?.sections.every((s) => s.provenance?.source === "seed")).toBe(true);
      expect(doc?.sections[0]?.provenance?.confidence).toBe("high");
    }
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

  test("with a KB origin it opens one PR per document", async () => {
    const dir = kb();
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    const origin = mkdtempSync(join(tmpdir(), "homeostat-seed-origin-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "ci");
    git("config", "user.email", "ci@example.com");
    git("add", "-A");
    git("commit", "-qm", "init");
    git("remote", "add", "origin", origin);
    git("push", "-q", "origin", "main");
    const opened: NewPullRequest[] = [];
    const provider = {
      kind: "bitbucket",
      openPullRequest: async (_: unknown, pr: NewPullRequest) => {
        opened.push(pr);
        return { id: opened.length, url: `u${opened.length}` };
      },
    } as unknown as Provider;
    await seed(
      [
        codeRepo(),
        "--area",
        "integrations",
        "--owner",
        "dana",
        "--dir",
        dir,
        "--topic",
        "architecture",
        "--topic",
        "cross-repo",
      ],
      {
        seeder: new FakeSeeder(),
        provider,
      },
    );
    expect(opened.map((p) => p.title)).toEqual([
      "homeostat: first architecture document for integrations, from " +
        opened[0]?.title.split("from ")[1],
      "homeostat: first cross-repo document for integrations, from " +
        opened[1]?.title.split("from ")[1],
    ]);
    expect(opened[0]?.body).toContain("Every section is marked `source=seed`");
  });

  test("never overwrites an existing document without --force", async () => {
    const dir = kb();
    const seeder = new FakeSeeder();
    mkdirSync(join(dir, "knowledge/integrations/docs"), { recursive: true });
    cpSync(
      join(dir, "knowledge/integrations/docs/partner-calls.md"),
      join(dir, "knowledge/integrations/docs/architecture.md"),
    );
    const { stdout } = await seed(
      [
        codeRepo(),
        "--area",
        "integrations",
        "--owner",
        "dana",
        "--dir",
        dir,
        "--topic",
        "architecture",
      ],
      { seeder },
    );
    expect(stdout).toContain("skip knowledge/integrations/docs/architecture.md: it already exists");
    expect(seeder.seen).toEqual([]);
  });
});
