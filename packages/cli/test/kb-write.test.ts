import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTopicFile, parseEntry, parseTopicFile, ruleSection } from "@homeostat/core";
import { describe, expect, test } from "vitest";
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

    expect(rebuildOnBase(t.dir, "main", branch)).toEqual({ rebuilt: true });
    t.g("fetch", "-q", "origin");
    expect(ids(t.g("show", `origin/${branch}:${HTTP}`))).toEqual(["a-rule", "b-rule", "c-rule"]);
    // The branch now sits on top of main, so the host can merge it.
    expect(t.g("merge-base", "--is-ancestor", "origin/main", `origin/${branch}`)).toBe("");
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
