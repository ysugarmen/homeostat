import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyFixes } from "../src/fix.ts";
import { type KbFiles, validate } from "../src/validate.ts";

const examples = new URL("../../../examples/", import.meta.url).pathname;

function readKb(name: string): KbFiles {
  const root = join(examples, name);
  const files: KbFiles = {};
  for (const f of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".md") || f.endsWith(".yaml")) files[f] = readFileSync(join(root, f), "utf8");
  }
  return files;
}

const codes = (files: KbFiles) => validate(files).issues.map((i) => i.code);
const ENTRY = "knowledge/integrations/outbound-http-retry-helper.md";

describe("validate", () => {
  test("starter-kb is green", () => {
    const result = validate(readKb("starter-kb"));
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(3);
  });

  test("broken-kb is red, with every issue located", () => {
    const result = validate(readKb("broken-kb"));
    expect(result.ok).toBe(false);
    expect(result.issues.every((i) => i.file)).toBe(true);
  });

  test("missing homeostat.yaml is an error but entries are still checked", () => {
    const files = readKb("starter-kb");
    delete files["homeostat.yaml"];
    const result = validate(files);
    expect(result.issues.map((i) => i.code)).toEqual(["config.missing"]);
    expect(result.entries).toHaveLength(3);
  });

  test("non-entry files are ignored", () => {
    const files = { ...readKb("starter-kb"), "README.md": "# hi", "docs/x.md": "nope" };
    expect(codes(files)).toEqual([]);
  });

  test("a hand-edited score is a fixable warning", () => {
    const files = readKb("starter-kb");
    files[ENTRY] = files[ENTRY]?.replace("score: 4", "score: 9") ?? "";
    const result = validate(files);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "score.mismatch",
        severity: "warning",
        file: ENTRY,
        fix: { field: "score", value: 4 },
      }),
    ]);
  });

  test("the threshold check uses the computed score, not the hand-edited one", () => {
    const files = readKb("starter-kb");
    const path = "knowledge/core/redact-before-logging.md";
    files[path] =
      files[path]?.replace("score: 2", "score: 5").replace("approvedBy: dana\n", "") ?? "";
    expect(codes(files)).toEqual(["accepted.belowThreshold", "score.mismatch"]);
  });

  test("conflicts across entries are reported on the right file", () => {
    const files = readKb("starter-kb");
    files[ENTRY] =
      files[ENTRY]?.replace(
        "status: accepted",
        "status: disputed\nconflictsWith: [redact-before-logging]",
      ) ?? "";
    const result = validate(files);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "conflict.one-sided-conflict", file: ENTRY }),
    );
  });
});

describe("applyFixes", () => {
  test("rewrites only the fixed fields and keeps the rest byte-for-byte", () => {
    const original = readKb("starter-kb")[ENTRY] ?? "";
    const broken = original.replace("score: 4", "score: 9").replace(/tokens: \d+/, "tokens: 1");
    const files = { ...readKb("starter-kb"), [ENTRY]: broken };
    const fixes = validate(files).issues.flatMap((i) => (i.fix ? [i.fix] : []));
    expect(applyFixes(broken, fixes)).toBe(original);
  });

  test("leaves files without frontmatter alone", () => {
    expect(applyFixes("no frontmatter", [{ field: "score", value: 1 }])).toBe("no frontmatter");
  });
});
