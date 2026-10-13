import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { checkEntry } from "../src/check.ts";
import { parseConfig } from "../src/config.ts";
import { parseEntry } from "../src/entry.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

function loadKb(name: string) {
  const root = join(examples, name);
  const { config, issues } = parseConfig(readFileSync(join(root, "homeostat.yaml"), "utf8"));
  if (!config) throw new Error(JSON.stringify(issues));
  const files = readdirSync(join(root, "knowledge"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => relative(root, join(root, "knowledge", f)));
  return { root, config, files };
}

function issuesFor(name: string) {
  const { root, config, files } = loadKb(name);
  return files.flatMap((path) => {
    const { entry, issues } = parseEntry(readFileSync(join(root, path), "utf8"));
    if (!entry) return issues;
    return [
      ...issues,
      ...checkEntry(entry, {
        path,
        areas: Object.keys(config.areas),
        autoMergeThreshold: config.scoring.autoMergeThreshold,
        members: config.team.members.map((m) => m.id),
      }),
    ];
  });
}

describe("examples", () => {
  test("starter-kb has three entries and no issues", () => {
    expect(loadKb("starter-kb").files).toHaveLength(3);
    expect(issuesFor("starter-kb")).toEqual([]);
  });

  test("broken-kb fails with located messages", () => {
    expect(issuesFor("broken-kb").map((i) => i.message)).toEqual([
      "title: must be at most 80 characters",
      "created: must be a real calendar date",
      'vertical: unknown key; did you mean "area"?',
      "text before the first section; start the body with ## Rule",
      'unknown section "## Notes"; allowed: Rule, Why, Example',
      "missing or empty ## Why section",
    ]);
  });
});
