import { describe, expect, test } from "vitest";
import { parseDoc } from "../src/doc.ts";
import { docContext } from "../src/doc-context.ts";

function doc(name: string, sections: number, opts: { area?: string; scope?: string } = {}) {
  const area = opts.area ?? "core";
  const body = Array.from(
    { length: sections },
    (_, i) =>
      `## Section ${i} {#a-long-section-id-for-${name}-${i}}\nText ${i}${i === 1 ? " about services/api/handler.ts" : ""}.`,
  ).join("\n\n");
  const text = `---\ntitle: ${name}\narea: ${area}\nowner: dana\nscope: ["${opts.scope ?? "**"}"]\nupdated: 2026-10-12\n---\n\n${body}\n`;
  const parsed = parseDoc(text).doc;
  if (!parsed) throw new Error(`bad fixture ${name}`);
  return { path: `knowledge/${area}/docs/${name}.md`, doc: parsed };
}

describe("docContext", () => {
  const docs = [
    doc("big", 40),
    doc("second", 3, { area: "api", scope: "services/api/**" }),
    doc("third", 3, { area: "web", scope: "apps/web/**" }),
  ];
  const opts = { tokenBudget: 10_000, maxChars: 10_000 };

  test("counts the covering documents by area and never lists their titles", () => {
    const ctx = docContext(docs, ["services/api/handler.ts"], opts);
    expect(ctx.listed).toEqual(["core/big", "api/second"]);
    expect([...ctx.byArea]).toEqual([
      ["api", 1],
      ["core", 1],
    ]);
    expect(ctx.text).not.toContain("second (");
    expect(ctx.text).not.toContain("a-long-section-id-for-big-0");
  });

  test("gives in full the sections that name a touched path", () => {
    const ctx = docContext(docs, ["services/api/handler.ts"], opts);
    expect(ctx.sections).toEqual([
      { doc: "api/second", id: "a-long-section-id-for-second-1" },
      { doc: "core/big", id: "a-long-section-id-for-big-1" },
    ]);
    expect(ctx.text).toMatch(/^# Team document sections/);
    expect(ctx.text).toContain("## Section 1 (api/second#a-long-section-id-for-second-1)");
  });

  test("no section names a touched file: no text, still counted", () => {
    const ctx = docContext(docs, ["apps/web/App.tsx"], opts);
    expect(ctx.text).toBe("");
    expect(ctx.listed).toEqual(["core/big", "web/third"]);
  });

  test("sections stay within the character limit", () => {
    const ctx = docContext(docs, ["services/api/handler.ts"], { ...opts, maxChars: 150 });
    expect(ctx.text.length).toBeLessThanOrEqual(150);
    expect(ctx.sections).toHaveLength(1);
  });
});
