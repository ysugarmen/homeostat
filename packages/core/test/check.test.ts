import { describe, expect, test } from "vitest";
import { type CheckContext, checkEntry } from "../src/check.ts";
import { type Entry, parseEntry } from "../src/entry.ts";
import { countTokens } from "../src/tokens.ts";
import { entryFile, validFrontmatter } from "./helpers.ts";

const ctx: CheckContext = {
  path: "knowledge/integrations/outbound-http-retry-helper.md",
  areas: ["integrations", "frontend"],
  autoMergeThreshold: 3,
  members: ["dana", "lee"],
};

/** Parses an entry and sets `tokens` to the true count, so only the patched rule can fail. */
function entry(patch: (fm: Record<string, unknown>) => void = () => {}): Entry {
  const fm: Record<string, unknown> = validFrontmatter();
  patch(fm);
  const parsed = parseEntry(entryFile(fm));
  if (!parsed.entry) throw new Error(JSON.stringify(parsed.issues));
  parsed.entry.frontmatter.tokens = countTokens(parsed.entry.body);
  return parsed.entry;
}

const codes = (e: Entry, c: Partial<CheckContext> = {}) =>
  checkEntry(e, { ...ctx, ...c }).map((i) => i.code);

describe("checkEntry", () => {
  test("a correct entry has no issues", () => {
    expect(codes(entry())).toEqual([]);
  });

  test("filename must equal id", () => {
    expect(codes(entry(), { path: "knowledge/integrations/retry.md" })).toEqual(["path.filename"]);
  });

  test("folder must equal area", () => {
    expect(codes(entry(), { path: "knowledge/frontend/outbound-http-retry-helper.md" })).toEqual([
      "path.folder",
    ]);
  });

  test("entry must live under knowledge/", () => {
    expect(codes(entry(), { path: "notes/integrations/outbound-http-retry-helper.md" })).toEqual([
      "path.root",
    ]);
  });

  test("area must be a configured area or core", () => {
    expect(codes(entry(), { areas: ["frontend"] })).toEqual(["area.unknown"]);
    const core = entry((fm) => (fm.area = "core"));
    expect(codes(core, { path: "knowledge/core/outbound-http-retry-helper.md" })).toEqual([]);
  });

  test("accepted below threshold needs approvedBy", () => {
    expect(codes(entry((fm) => (fm.score = 2)))).toEqual(["accepted.belowThreshold"]);
    expect(
      codes(
        entry((fm) => {
          fm.score = 2;
          fm.approvedBy = "lee";
        }),
      ),
    ).toEqual([]);
  });

  test("threshold only applies to accepted entries", () => {
    expect(
      codes(
        entry((fm) => {
          fm.score = 0;
          fm.status = "candidate";
        }),
      ),
    ).toEqual([]);
  });

  test("owner, author and approvedBy must be members when members are known", () => {
    expect(codes(entry((fm) => (fm.owner = "ghost")))).toEqual(["member.unknown"]);
    expect(codes(entry((fm) => (fm.approvedBy = "ghost")))).toEqual(["member.unknown"]);
    expect(
      codes(
        entry((fm) => (fm.owner = "ghost")),
        { members: undefined },
      ),
    ).toEqual([]);
  });

  test("stale tokens are a fixable warning, not an error", () => {
    const e = entry();
    const real = e.frontmatter.tokens;
    e.frontmatter.tokens = real + 5;
    const issues = checkEntry(e, ctx);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "tokens.mismatch",
        severity: "warning",
        fix: { field: "tokens", value: real },
      }),
    ]);
  });
});

describe("countTokens", () => {
  test("counts a non-empty body", () => {
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("")).toBe(0);
  });
});
