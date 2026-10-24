import { describe, expect, test } from "vitest";
import { parseDoc } from "../src/doc.ts";
import { mergeDocText } from "../src/doc-merge.ts";

const doc = (updated: string, sections: [string, string, string][]) =>
  `---\ntitle: Anti-patterns\narea: core\nowner: dana\nscope: ["**"]\nupdated: ${updated}\n---\n\nWhat to avoid.\n\n${sections
    .map(
      ([id, date, body]) =>
        `## ${id[0]?.toUpperCase()}${id.slice(1)} {#${id}}\n<!-- homeostat: source=curator updated=${date} -->\n${body}`,
    )
    .join("\n\n")}\n`;

const was = doc("2026-10-20", [
  ["code", "2026-10-20", "Old advice."],
  ["tests", "2026-10-20", "Test advice."],
]);

describe("mergeDocText", () => {
  test("two additions to one section are combined, with the later provenance", () => {
    const ours = doc("2026-10-22", [
      ["code", "2026-10-22", "Old advice.\n\n### Gather\nDo not gather."],
      ["tests", "2026-10-20", "Test advice."],
    ]);
    const theirs = doc("2026-10-24", [
      ["code", "2026-10-24", "Old advice.\n\n### Regex\nUse fullmatch."],
      ["tests", "2026-10-20", "Test advice."],
    ]);
    const m = mergeDocText(was, ours, theirs);
    expect(m.conflicts).toEqual([]);
    const code = parseDoc(m.text ?? "").doc?.sections.find((s) => s.id === "code");
    expect(code?.body).toBe(
      "Old advice.\n\n### Gather\nDo not gather.\n\n### Regex\nUse fullmatch.",
    );
    expect(code?.provenance?.updated).toBe("2026-10-24");
    expect(m.text).toContain("updated: 2026-10-24");
  });

  test("a section only the PR changed is taken, and a new one is added; the base's bytes stay", () => {
    const ours = was.replace("What to avoid.", "What to avoid, and why.");
    const theirs = doc("2026-10-24", [
      ["code", "2026-10-20", "Old advice."],
      ["tests", "2026-10-24", "Better test advice."],
      ["logging", "2026-10-24", "Log ids, not bodies."],
    ]);
    const m = mergeDocText(was, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.text).toContain("What to avoid, and why.");
    expect(m.text).toContain("Better test advice.");
    expect(m.text).toContain("## Logging {#logging}");
  });

  test("two rewrites of one section are left for a person", () => {
    const ours = doc("2026-10-22", [
      ["code", "2026-10-22", "New advice from main."],
      ["tests", "2026-10-20", "Test advice."],
    ]);
    const theirs = doc("2026-10-24", [
      ["code", "2026-10-24", "Different advice from the PR."],
      ["tests", "2026-10-20", "Test advice."],
    ]);
    expect(mergeDocText(was, ours, theirs).conflicts).toEqual(["code"]);
  });

  test("a section the PR dropped while the base kept it is left for a person", () => {
    const theirs = doc("2026-10-24", [["code", "2026-10-20", "Old advice."]]);
    expect(mergeDocText(was, was, theirs).conflicts).toEqual(["tests"]);
  });
});
