import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseDoc,
  type RepoSnapshot,
  type SeedDraft,
  type Seeder,
  type SeedTopic,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-multi-kb", import.meta.url).pathname;

/** A KB and a checkout of its `api` repo side by side, as on a developer's machine. */
function workspace() {
  const top = mkdtempSync(join(tmpdir(), "homeostat-bootstrap-"));
  const kb = join(top, "team-kb");
  cpSync(starter, kb, { recursive: true });
  const code = join(top, "integrations-api");
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(code, p)), { recursive: true });
    writeFileSync(join(code, p), text);
  };
  put("README.md", "# Integrations API\nRoutes partner calls.\n\n## Running\nUse make run.\n");
  put("docs/queues.md", "# Queues\n\n## Retries\nJobs retry three times.\n");
  put("package.json", JSON.stringify({ name: "integrations-api" }));
  put("db/migrations/0001_init.sql", "CREATE TABLE partners (id int primary key);\n");
  put("charts/api/Chart.yaml", "name: api\nversion: 1.0.0\n");
  put("k8s/creds.yaml", "apiVersion: v1\nkind: Secret\ndata:\n  token: eA==\n");
  execFileSync("git", ["-C", code, "init", "-q"]);
  execFileSync("git", [
    "-C",
    code,
    "remote",
    "add",
    "origin",
    "git@bitbucket.org:acme/integrations-api.git",
  ]);
  execFileSync("git", ["-C", code, "add", "-A"]);
  return { top, kb, code };
}

class FakeSeeder implements Seeder {
  seen: { snapshot: RepoSnapshot; topic: SeedTopic }[] = [];
  async draft(snapshot: RepoSnapshot, topic: SeedTopic): Promise<SeedDraft> {
    this.seen.push({ snapshot, topic });
    return {
      title: `Integrations ${topic}`,
      intro: `The ${topic} of the integrations API.`,
      sections: [{ heading: "Overview", body: "Partners live in one table.", confidence: "high" }],
    };
  }
}

async function bootstrap(kb: string, args: string[], extra: Partial<Io> = {}) {
  let stdout = "";
  const code = await runCli(["node", "homeostat", "bootstrap", "--dir", kb, ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stdout += s),
    color: false,
    env: {},
    now: () => new Date("2026-10-20T09:00:00Z"),
    ...extra,
  });
  return { code, stdout };
}

describe("homeostat bootstrap", () => {
  test("a dry run finds the checkout by its remote, lists what it reads, and sends nothing", async () => {
    const { kb } = workspace();
    const seeder = new FakeSeeder();
    const r = await bootstrap(kb, ["--dry-run"], { seeder });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("doc   README.md -> knowledge/api/core/docs/readme.md");
    expect(r.stdout).toContain("doc   docs/queues.md -> knowledge/api/core/docs/queues.md");
    expect(r.stdout).toContain("model data -> knowledge/api/core/docs/data.md: 1 files");
    expect(r.stdout).toContain("db/migrations/0001_init.sql");
    expect(r.stdout).not.toContain("k8s/creds.yaml");
    expect(r.stdout).toContain("skip web: no checkout found");
    expect(r.stdout).toMatch(/5 model calls to .*tokens in/);
    expect(seeder.seen).toHaveLength(0);
    expect(existsSync(join(kb, "knowledge/api/core/docs/readme.md"))).toBe(false);
  });

  test("asks before sending, then writes each part into the repo's folder", async () => {
    const { kb, code } = workspace();
    const seeder = new FakeSeeder();
    const no = await bootstrap(kb, ["--checkout", `api=${code}`], { seeder, ask: async () => "n" });
    expect(no.stdout).toContain("nothing sent");
    expect(seeder.seen).toHaveLength(0);

    const r = await bootstrap(kb, ["--checkout", `api=${code}`, "--repo", "api"], {
      seeder,
      ask: async () => "y",
    });
    expect(r.code).toBe(0);
    expect(seeder.seen.map((s) => s.topic)).toEqual([
      "architecture",
      "conventions",
      "cross-repo",
      "data",
      "infrastructure",
    ]);
    const data = parseDoc(readFileSync(join(kb, "knowledge/api/core/docs/data.md"), "utf8")).doc;
    expect(data?.sections[0]?.provenance?.source).toBe("bootstrap");
    const readme = parseDoc(
      readFileSync(join(kb, "knowledge/api/core/docs/readme.md"), "utf8"),
    ).doc;
    expect(readme?.frontmatter.title).toBe("Integrations API");
    expect(readme?.sections[0]?.provenance?.source).toBe("imported");

    // A second run skips what is already there.
    const again = await bootstrap(kb, ["--checkout", `api=${code}`, "--dry-run"], { seeder });
    expect(again.stdout).toContain("knowledge/api/core/docs/data.md: already in the KB");
  });

  test("without a terminal it needs --yes", async () => {
    const { kb, code } = workspace();
    const r = await bootstrap(kb, ["--checkout", `api=${code}`, "--parts", "data"], {
      seeder: new FakeSeeder(),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("--yes");
  });
});
