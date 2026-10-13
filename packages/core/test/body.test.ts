import { describe, expect, test } from "vitest";
import { parseBody } from "../src/body.ts";
import { validBody, words } from "./helpers.ts";

const codes = (body: string) => parseBody(body).issues.map((i) => i.code);

describe("parseBody", () => {
  test("splits Rule, Why and Example", () => {
    const { sections, issues } = parseBody(validBody);
    expect(issues).toEqual([]);
    expect(sections.rule).toMatch(/^Wrap every outbound HTTP call/);
    expect(sections.why).toMatch(/^Partner APIs time out/);
    expect(sections.example).toMatch(/^```ts/);
  });

  test("Example is optional", () => {
    const { sections, issues } = parseBody("## Rule\nDo the thing.\n\n## Why\nBecause.\n");
    expect(issues).toEqual([]);
    expect(sections.example).toBeUndefined();
  });

  test("missing Rule is an error", () => {
    expect(codes("## Why\nBecause.\n")).toContain("body.rule.missing");
  });

  test("missing Why is an error", () => {
    expect(codes("## Rule\nDo it.\n")).toContain("body.why.missing");
  });

  test("an empty section counts as missing", () => {
    expect(codes("## Rule\n\n## Why\nBecause.\n")).toContain("body.rule.missing");
  });

  test("Rule at 60 words passes, 61 fails", () => {
    expect(codes(`## Rule\n${words(60)}\n\n## Why\nBecause.\n`)).toEqual([]);
    expect(codes(`## Rule\n${words(61)}\n\n## Why\nBecause.\n`)).toEqual(["body.rule.tooLong"]);
  });

  test("Why at 100 words passes, 101 fails", () => {
    expect(codes(`## Rule\nDo it.\n\n## Why\n${words(100)}\n`)).toEqual([]);
    expect(codes(`## Rule\nDo it.\n\n## Why\n${words(101)}\n`)).toEqual(["body.why.tooLong"]);
  });

  test("Rule must be a single paragraph", () => {
    expect(codes("## Rule\nFirst.\n\nSecond.\n\n## Why\nBecause.\n")).toContain(
      "body.rule.multiParagraph",
    );
  });

  test("unknown and duplicate headings are errors", () => {
    expect(codes("## Rule\nA.\n\n## Why\nB.\n\n## Notes\nC.\n")).toContain("body.section.unknown");
    expect(codes("## Rule\nA.\n\n## Rule\nA.\n\n## Why\nB.\n")).toContain("body.section.duplicate");
  });

  test("text before the first heading is an error", () => {
    expect(codes("Intro.\n\n## Rule\nA.\n\n## Why\nB.\n")).toContain("body.preamble");
  });

  test("headings inside code fences are not sections", () => {
    const body = "## Rule\nA.\n\n## Why\nB.\n\n## Example\n```md\n## Rule\nnested\n```\n";
    const { sections, issues } = parseBody(body);
    expect(issues).toEqual([]);
    expect(sections.example).toContain("## Rule\nnested");
  });

  test("heading match is case-insensitive", () => {
    expect(codes("## rule\nA.\n\n## WHY\nB.\n")).toEqual([]);
  });
});
