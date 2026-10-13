import { describe, expect, test } from "vitest";
import { parseEntry } from "../src/entry.ts";
import { entryFile, validFrontmatter } from "./helpers.ts";

const codes = (text: string) => parseEntry(text).issues.map((i) => i.code);
const withFm = (patch: (fm: Record<string, unknown>) => void) => {
  const fm: Record<string, unknown> = validFrontmatter();
  patch(fm);
  return entryFile(fm);
};

describe("parseEntry", () => {
  test("parses a valid entry", () => {
    const { entry, issues } = parseEntry(entryFile());
    expect(issues).toEqual([]);
    expect(entry?.frontmatter.id).toBe("outbound-http-retry-helper");
    expect(entry?.frontmatter.created).toBe("2026-09-30");
    expect(entry?.sections.rule).toMatch(/^Wrap/);
  });

  test("missing frontmatter block", () => {
    expect(codes("## Rule\nA.\n\n## Why\nB.\n")).toEqual(["frontmatter.missing"]);
  });

  test("invalid YAML", () => {
    expect(codes("---\nid: [unclosed\n---\n## Rule\nA.\n## Why\nB.\n")).toEqual([
      "frontmatter.yaml",
    ]);
  });

  test.each([
    "id",
    "title",
    "area",
    "scope",
    "status",
    "score",
    "owner",
    "source",
    "created",
    "lastConfirmed",
    "tokens",
  ])("required field %s", (field) => {
    const issues = parseEntry(withFm((fm) => delete fm[field])).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: "schema", path: field }));
  });

  test("source.author is required", () => {
    const issues = parseEntry(
      withFm((fm) => delete (fm.source as Record<string, unknown>).author),
    ).issues;
    expect(issues).toContainEqual(expect.objectContaining({ path: "source.author" }));
  });

  test.each([["Has Caps"], ["under_score"], ["spa ce"], [""]])("id %j is rejected", (id) => {
    expect(codes(withFm((fm) => (fm.id = id)))).toContain("schema");
  });

  test("title over 80 chars is rejected", () => {
    expect(codes(withFm((fm) => (fm.title = "x".repeat(81))))).toContain("schema");
    expect(codes(withFm((fm) => (fm.title = "x".repeat(80))))).toEqual([]);
  });

  test("scope must be a non-empty list", () => {
    expect(codes(withFm((fm) => (fm.scope = [])))).toContain("schema");
    expect(codes(withFm((fm) => (fm.scope = "**")))).toContain("schema");
  });

  test("status and source.type are enums", () => {
    expect(codes(withFm((fm) => (fm.status = "draft")))).toContain("schema");
    expect(
      codes(withFm((fm) => ((fm.source as Record<string, unknown>).type = "slack"))),
    ).toContain("schema");
  });

  test("score and tokens are integers", () => {
    expect(codes(withFm((fm) => (fm.score = 1.5)))).toContain("schema");
    expect(codes(withFm((fm) => (fm.tokens = -1)))).toContain("schema");
  });

  test("dates must be ISO calendar dates", () => {
    expect(codes(withFm((fm) => (fm.created = "30/09/2026")))).toContain("schema");
    expect(codes(withFm((fm) => (fm.lastConfirmed = "2026-02-30")))).toContain("schema");
  });

  test("unknown fields are rejected, so typos like `vertical` surface", () => {
    expect(codes(withFm((fm) => (fm.vertical = "integrations")))).toContain("schema");
  });

  describe("cross-field rules", () => {
    test("pr-feedback requires source.url", () => {
      const issues = parseEntry(
        withFm((fm) => delete (fm.source as Record<string, unknown>).url),
      ).issues;
      expect(issues).toContainEqual(
        expect.objectContaining({ code: "source.url.required", path: "source.url" }),
      );
    });

    test("pr-feedback requires source.changedCode", () => {
      const issues = parseEntry(
        withFm((fm) => delete (fm.source as Record<string, unknown>).changedCode),
      ).issues;
      expect(issues).toContainEqual(
        expect.objectContaining({ code: "source.changedCode.required" }),
      );
    });

    test("manual entries need no url", () => {
      expect(codes(withFm((fm) => (fm.source = { type: "manual", author: "dana" })))).toEqual([]);
    });

    test("non-empty conflictsWith forces status disputed", () => {
      expect(codes(withFm((fm) => (fm.conflictsWith = ["other-entry"])))).toContain(
        "conflicts.notDisputed",
      );
      expect(
        codes(
          withFm((fm) => {
            fm.conflictsWith = ["other-entry"];
            fm.status = "disputed";
          }),
        ),
      ).toEqual([]);
    });

    test("an entry cannot conflict with or supersede itself", () => {
      expect(
        codes(
          withFm((fm) => {
            fm.status = "disputed";
            fm.conflictsWith = ["outbound-http-retry-helper"];
          }),
        ),
      ).toContain("conflicts.self");
      expect(codes(withFm((fm) => (fm.supersedes = "outbound-http-retry-helper")))).toContain(
        "supersedes.self",
      );
    });
  });

  test("body issues are reported alongside frontmatter issues", () => {
    const text = entryFile({ ...validFrontmatter(), score: "high" }, "## Rule\nA.\n");
    expect(codes(text)).toEqual(expect.arrayContaining(["schema", "body.why.missing"]));
  });
});
