import { describe, expect, test } from "vitest";
import { parseDoc } from "../src/doc.ts";
import { docContext } from "../src/doc-context.ts";

function doc(name: string, sections: number) {
  const body = Array.from(
    { length: sections },
    (_, i) => `## Section ${i} {#a-long-section-id-for-${name}-${i}}\nText ${i}.`,
  ).join("\n\n");
  const text = `---\ntitle: ${name}\narea: core\nowner: dana\nscope: ["**"]\nupdated: 2026-10-12\n---\n\n${body}\n`;
  const parsed = parseDoc(text).doc;
  if (!parsed) throw new Error(`bad fixture ${name}`);
  return { path: `knowledge/core/docs/${name}.md`, doc: parsed };
}

describe("docContext index", () => {
  const docs = [doc("big", 40), doc("second", 3), doc("third", 3)];
  const opts = { tokenBudget: 10_000, readHint: "Read with `read`." };

  test("one long document does not push the others out", () => {
    const ctx = docContext(docs, [], { ...opts, maxChars: 600 });
    expect(ctx.listed).toEqual(["core/big", "core/second", "core/third"]);
    expect(ctx.text.length).toBeLessThanOrEqual(600);
    expect(ctx.text).toContain("a-long-section-id-for-second-0");
  });

  test("lists as many documents as fit when titles alone are too long", () => {
    const ctx = docContext(docs, [], { ...opts, maxChars: 130 });
    expect(ctx.listed.length).toBeGreaterThan(0);
    expect(ctx.listed.length).toBeLessThan(3);
    expect(ctx.text.length).toBeLessThanOrEqual(130);
  });
});
