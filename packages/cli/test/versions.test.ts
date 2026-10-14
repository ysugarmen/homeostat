import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { VERSION } from "@homeostat/core";
import { describe, expect, test } from "vitest";

const root = new URL("../../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(md|mjs|ts|json|ya?ml)$/.test(f));

/** Docs that discuss floating versions as the threat, not as an instruction. */
const NARRATIVE = new Set(["docs/security.md", "docs/execution-plan.md", "docs/releasing.md"]);

describe("pinned releases (T4)", () => {
  test("every package and the plugin carry the one release version", () => {
    for (const path of [
      "packages/cli/package.json",
      "packages/core/package.json",
      "packages/mcp/package.json",
      "packages/dashboard/package.json",
      "packages/plugin/.claude-plugin/plugin.json",
    ]) {
      expect(JSON.parse(read(path)).version, path).toBe(VERSION);
    }
  });

  test("every homeostat@ reference is the exact release version, never a range", () => {
    const bad: string[] = [];
    for (const file of tracked.filter((f) => !NARRATIVE.has(f))) {
      for (const m of read(file).matchAll(
        /\bhomeostat@([\d^~*][^\s"'`)\]]*|latest|next|\$\{\w+\})/g,
      )) {
        if (m[1] !== VERSION && m[1] !== "${VERSION}" && m[1] !== "${version}") {
          bad.push(`${file}: homeostat@${m[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("the plugin launcher's npx fallback uses the plugin's own version", () => {
    expect(read("packages/plugin/hooks/run.mjs")).toContain("`homeostat@${version}`");
  });
});
