import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Provider, readKbFiles, validate } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-migrate-"));
  cpSync(starter, dir, { recursive: true });
  return dir;
};
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
const MAP = ["--map", "integrations=integrations-api", "--map", "frontend=web-app", "--shared"];

describe("homeostat migrate", () => {
  test("moves a KB with two source repos to the multi-repo layout, by the map", async () => {
    const dir = copy();
    const { code, stdout } = await run(["migrate", "--dir", dir, ...MAP, "--skip-pr-check"]);
    expect(code).toBe(0);
    for (const m of ["core → shared", "integrations → integrations-api", "frontend → web-app"]) {
      expect(stdout).toContain(m);
    }
    expect(
      existsSync(
        join(dir, "knowledge/integrations-api/integrations/outbound-http-retry-helper.md"),
      ),
    ).toBe(true);
    expect(existsSync(join(dir, "knowledge/integrations/outbound-http-retry-helper.md"))).toBe(
      false,
    );
    const kb = validate(readKbFiles(dir));
    expect(kb.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(Object.keys(kb.config?.repos ?? {})).toEqual(["integrations-api", "web-app"]);
  });

  test("with two repos and no map, or with a homeostat PR open, it changes nothing", async () => {
    const dir = copy();
    const noMap = await run(["migrate", "--dir", dir, "--skip-pr-check"]);
    expect(noMap.code).toBe(1);
    expect(noMap.stderr).toContain("map each area to one");
    const provider = {
      listOpenPullRequests: async () => [
        { id: 4, sourceBranch: "homeostat/review-lee-2026-10-20" },
      ],
    } as unknown as Provider;
    const open = await run(["migrate", "--dir", dir, ...MAP], { provider });
    expect(open.code).toBe(1);
    expect(open.stderr).toContain("homeostat/review-lee-2026-10-20");
    expect(existsSync(join(dir, "knowledge/integrations/outbound-http-retry-helper.md"))).toBe(
      true,
    );
  });

  test("--topics groups the rules into the topics proposed; --dry-run writes nothing", async () => {
    const dir = copy();
    const topicProposer = {
      propose: async (rules: readonly { id: string }[]) => ({
        topics: { http: "Outbound HTTP calls" },
        assign: Object.fromEntries(
          rules.filter((r) => r.id.includes("http")).map((r) => [r.id, "http"]),
        ),
      }),
    };
    const dry = await run(
      ["migrate", "--dir", dir, ...MAP, "--topics", "--dry-run", "--skip-pr-check"],
      {
        topicProposer,
      },
    );
    expect(dry.stdout).toContain("http (1): Outbound HTTP calls");
    expect(dry.stdout).toContain("dry run: nothing written");
    expect(existsSync(join(dir, "knowledge/integrations/outbound-http-retry-helper.md"))).toBe(
      true,
    );

    expect(
      (
        await run(["migrate", "--dir", dir, ...MAP, "--topics", "--skip-pr-check"], {
          topicProposer,
        })
      ).code,
    ).toBe(0);
    expect(
      readFileSync(join(dir, "knowledge/integrations-api/integrations/http.md"), "utf8"),
    ).toContain("{#outbound-http-retry-helper}");
    expect(validate(readKbFiles(dir)).issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  test("a developer's pending lesson at an old path moves on their next sync", async () => {
    const origin = mkdtempSync(join(tmpdir(), "homeostat-migrate-origin-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const kb = copy();
    const g = (d: string, ...a: string[]) =>
      execFileSync(
        "git",
        ["-C", d, "-c", "user.name=Lee", "-c", "user.email=lee@example.com", ...a],
        {
          encoding: "utf8",
        },
      );
    g(kb, "init", "-q", "-b", "main");
    g(kb, "add", "-A");
    g(kb, "commit", "-qm", "kb");
    g(kb, "remote", "add", "origin", origin);
    g(kb, "push", "-q", "origin", "main");
    const lee = mkdtempSync(join(tmpdir(), "homeostat-migrate-lee-"));
    execFileSync("git", ["clone", "-q", origin, lee]);
    execFileSync("git", ["-C", lee, "config", "user.name", "Lee"]);
    execFileSync("git", ["-C", lee, "config", "user.email", "lee@example.com"]);
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
      "Raw buttons skip the focus ring.",
    ]);
    const old = join(
      lee,
      ".homeostat/pending/knowledge/frontend/use-the-shared-button-component.md",
    );
    expect(existsSync(old)).toBe(true);

    expect((await run(["migrate", "--dir", kb, ...MAP, "--skip-pr-check"])).code).toBe(0);
    g(kb, "add", "-A");
    g(kb, "commit", "-qm", "migrate");
    g(kb, "push", "-q", "origin", "main");

    const { stdout } = await run(["sync", "--dir", lee]);
    expect(stdout).toContain("moved your pending use-the-shared-button-component");
    expect(existsSync(old)).toBe(false);
    expect(
      existsSync(
        join(
          lee,
          ".homeostat/pending/knowledge/web-app/frontend/use-the-shared-button-component.md",
        ),
      ),
    ).toBe(true);
  });
});
