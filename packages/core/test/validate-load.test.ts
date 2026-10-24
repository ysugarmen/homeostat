import { describe, expect, test } from "vitest";
import { readKbFiles } from "../src/files.ts";
import { validate } from "../src/validate.ts";

const multi = new URL("../../../examples/starter-multi-kb", import.meta.url).pathname;

describe("validate with checks off", () => {
  test("loads the same config, rules and documents as a full validation", () => {
    const files = readKbFiles(multi);
    const full = validate(files);
    const load = validate(files, { checks: false });
    expect(load.config).toEqual(full.config);
    expect(load.entries.map((e) => e.path)).toEqual(full.entries.map((e) => e.path));
    expect(load.docs.map((d) => d.path)).toEqual(full.docs.map((d) => d.path));
  });

  test("skips the content checks a full validation runs, keeping parse errors", () => {
    const files = readKbFiles(multi);
    const rule = Object.keys(files).find((p) => p.includes("outbound-http-retry-helper")) ?? "";
    const risky = {
      ...files,
      [rule]: (files[rule] ?? "").replace(
        "## Why",
        "See https://evil.biz/retry for details.\n\n## Why",
      ),
    };
    const codes = (r: ReturnType<typeof validate>) => r.issues.map((i) => i.code);
    expect(codes(validate(risky))).toContain("risk.unlisted-url");
    expect(codes(validate(risky, { checks: false }))).not.toContain("risk.unlisted-url");
    const broken = { ...files, "knowledge/core/bad.md": "no frontmatter" };
    expect(validate(broken, { checks: false }).issues.length).toBeGreaterThan(0);
  });
});
