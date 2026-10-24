import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTopicFile,
  type Provider,
  parseEntry,
  parseTopicFile,
  ruleSection,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { rebuildOnBase } from "../src/kb-write.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const HTTP = "knowledge/integrations/http.md";

/** A KB on a bare origin whose integrations rules live in a topic file, http.md. */
function kb() {
  const origin = mkdtempSync(join(tmpdir(), "homeostat-rebuild-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const dir = mkdtempSync(join(tmpdir(), "homeostat-rebuild-"));
  cpSync(starter, dir, { recursive: true });
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
      encoding: "utf8",
    }).trim();
  const retry = parseEntry(
    readFileSync(join(dir, "knowledge/integrations/outbound-http-retry-helper.md"), "utf8"),
  ).entry;
  if (!retry) throw new Error("starter rule");
  const section = (id: string, status = "accepted") => {
    const e = structuredClone(retry);
    e.frontmatter.id = id;
    e.frontmatter.status = status as never;
    return { id, raw: ruleSection(e) };
  };
  const write = (...sections: { id: string; raw: string }[]) =>
    writeFileSync(join(dir, HTTP), formatTopicFile({ topic: "http", title: "HTTP" }, sections));
  rmSync(join(dir, "knowledge/integrations/outbound-http-retry-helper.md"));
  write(section("a-rule"));
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-qm", "kb");
  g("remote", "add", "origin", origin);
  g("push", "-q", "origin", "main");
  return { dir, g, write, section };
}
const ids = (text: string) => parseTopicFile(HTTP, text).sections.map((s) => s.id);

describe("rebuildOnBase", () => {
  test("rules added to one topic file on both sides end up together, on top of the base", () => {
    const t = kb();
    const branch = "homeostat/review-lee-2026-10-20";
    t.g("checkout", "-q", "-b", branch);
    t.write(t.section("a-rule"), t.section("b-rule"));
    t.g("commit", "-qam", "lee's lesson");
    t.g("push", "-q", "origin", branch);
    t.g("checkout", "-q", "main");
    t.write(t.section("a-rule"), t.section("c-rule"));
    t.g("commit", "-qam", "a daily PR merged");
    t.g("push", "-q", "origin", "main");

    expect(rebuildOnBase(t.dir, "main", branch)).toMatchObject({ rebuilt: true });
    t.g("fetch", "-q", "origin");
    expect(ids(t.g("show", `origin/${branch}:${HTTP}`))).toEqual(["a-rule", "b-rule", "c-rule"]);
    // The branch now sits on top of main, so the host can merge it.
    expect(t.g("merge-base", "--is-ancestor", "origin/main", `origin/${branch}`)).toBe("");
  });

  test("additions to one document section on both sides are combined", () => {
    const t = kb();
    const DOC = "knowledge/integrations/docs/partner-calls.md";
    const docText = (extra: string) =>
      `---\ntitle: Partner calls\narea: integrations\nowner: dana\nscope: ["services/integrations/**"]\nupdated: 2026-10-20\n---\n\n## Timeouts {#timeouts}\n<!-- homeostat: source=manual updated=2026-10-20 -->\nPartner calls time out after 10 seconds.${extra}\n`;
    writeFileSync(join(t.dir, DOC), docText(""));
    t.g("add", "-A");
    t.g("commit", "-qm", "doc");
    t.g("push", "-q", "origin", "main");
    const branch = "homeostat/review-lee-2026-10-20";
    t.g("checkout", "-q", "-b", branch);
    writeFileSync(join(t.dir, DOC), docText("\n\nBooking confirmation waits up to 30."));
    t.g("commit", "-qam", "lee's doc edit");
    t.g("push", "-q", "origin", branch);
    t.g("checkout", "-q", "main");
    writeFileSync(join(t.dir, DOC), docText("\n\nRetries back off exponentially."));
    t.g("commit", "-qam", "a daily PR merged");
    t.g("push", "-q", "origin", "main");

    expect(rebuildOnBase(t.dir, "main", branch)).toMatchObject({ rebuilt: true });
    t.g("fetch", "-q", "origin");
    const merged = t.g("show", `origin/${branch}:${DOC}`);
    expect(merged).toContain("Retries back off exponentially.");
    expect(merged).toContain("Booking confirmation waits up to 30.");
  });

  test("the same rule changed on both sides is left for a person, and nothing is pushed", () => {
    const t = kb();
    const branch = "homeostat/review-lee-2026-10-20";
    t.g("checkout", "-q", "-b", branch);
    t.write(t.section("a-rule", "disputed"));
    t.g("commit", "-qam", "dispute");
    t.g("push", "-q", "origin", branch);
    const before = t.g("rev-parse", `refs/remotes/origin/${branch}`);
    t.g("checkout", "-q", "main");
    t.write(t.section("a-rule", "retired"));
    t.g("commit", "-qam", "retire");
    t.g("push", "-q", "origin", "main");

    const r = rebuildOnBase(t.dir, "main", branch);
    expect(r).toEqual({
      rebuilt: false,
      reason: `the same rules changed on both sides: ${HTTP}#a-rule`,
    });
    t.g("fetch", "-q", "origin");
    expect(t.g("rev-parse", `origin/${branch}`)).toBe(before);
  });
});

describe("homeostat review merge on a host that lags a force push", () => {
  test("waits for the rebuilt commit, nudges the host with an ordinary push, then merges", async () => {
    const t = kb();
    const config = join(t.dir, "homeostat.yaml");
    writeFileSync(config, `${readFileSync(config, "utf8")}\ntopics:\n  http: HTTP calls\n`);
    t.g("commit", "-qam", "topics");
    t.g("push", "-q", "origin", "main");
    const branch = "homeostat/review-lee-2026-10-20";
    t.g("checkout", "-q", "-b", branch);
    t.write(t.section("a-rule"), t.section("b-rule"));
    t.g("commit", "-qam", "lee's lesson");
    t.g("push", "-q", "origin", branch);
    const stale = t.g("rev-parse", "HEAD");
    t.g("checkout", "-q", "main");
    t.write(t.section("a-rule"), t.section("c-rule"));
    t.g("commit", "-qam", "a daily PR merged");
    t.g("push", "-q", "origin", "main");

    // Like Bitbucket this morning: a force push goes unseen, an ordinary push is noticed.
    const tip = () => t.g("ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] ?? "";
    const message = (sha: string) => t.g("log", "-1", "--format=%s", sha);
    let lookups = 0;
    const merged: number[] = [];
    const provider = {
      kind: "bitbucket",
      getPullRequest: async () => {
        lookups++;
        t.g("fetch", "-q", "origin");
        const now = tip();
        const seen = message(now) === "homeostat: refresh the PR" ? now : stale;
        return {
          id: 5,
          title: "homeostat: 1 lesson to review · lee · 2026-10-20",
          url: "https://bitbucket.org/acme/team-kb/pull-requests/5",
          author: { id: "ci" },
          sourceBranch: branch,
          targetBranch: "main",
          body: "",
          state: "open",
          createdAt: "2026-10-20T06:00:00Z",
          reviewers: [],
          conflicts: seen === stale,
          headSha: seen,
        };
      },
      mergePullRequest: async (_r: unknown, id: number) => {
        merged.push(id);
      },
    } as unknown as Provider;
    let out = "";
    const code = await runCli(["node", "homeostat", "review", "merge", "5", "--dir", t.dir], {
      stdout: (s) => (out += s),
      stderr: (s) => (out += s),
      color: false,
      env: {},
      provider,
      sleep: async () => {},
    });
    expect(out).toContain("rebuilt #5 on main");
    expect(code).toBe(0);
    expect(merged).toEqual([5]);
    expect(message(tip())).toBe("homeostat: refresh the PR");
    expect(lookups).toBeGreaterThan(2);
  });
});
