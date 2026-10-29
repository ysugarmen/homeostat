import { describe, expect, test } from "vitest";
import { type Doc, formatDoc, parseDoc } from "../src/doc.ts";
import { convertDoc } from "../src/doc-convert.ts";
import { normalizeDoc } from "../src/doc-normalize.ts";

const opts = {
  area: "core",
  owner: "dana",
  scope: ["**"],
  today: "2026-10-29",
  fallbackTitle: "guide",
};

/** `n` words of filler, as one paragraph. */
const prose = (n: number, word = "word") => Array.from({ length: n }, () => word).join(" ");

const codes = (text: string) => parseDoc(text).issues.map((i) => i.code);

function parsed(text: string): Doc {
  const { doc } = parseDoc(text);
  if (!doc) throw new Error("did not parse");
  return doc;
}

describe("convertDoc normalises what it imports", () => {
  test("drops a repeated # title and makes any other # heading a ## section", () => {
    const { text, notes } = convertDoc(
      "# Guide\n\nIntro.\n\n## Setup\nInstall it.\n\n# Guide\n\nMore setup.\n\n# Operations\n\nRun it.\n\n```sh\n# a shell comment, not a heading\nmake\n```\n",
      opts,
    );
    expect(codes(text)).not.toContain("doc.heading.h1");
    expect(text).not.toMatch(/^# (Guide|Operations)/m);
    expect(text).toContain("## Setup {#setup}\n<!-- homeostat: source=imported");
    expect(text).toContain("Install it.\n\nMore setup.");
    expect(text).toContain("## Operations {#operations}");
    expect(text).toContain("# a shell comment, not a heading");
    expect(notes).toContain('dropped the # heading "Guide": the title is in the frontmatter');
    expect(notes).toContain('# Operations became the ## section "Operations"');
  });

  test("splits a long section at its ### subheadings, with unique ids and headings", () => {
    const { text, notes } = convertDoc(
      `# Guide\n\n## Setup\n${prose(50)}\n\n### Install\n${prose(200)}\n\n### Configure\n${prose(200)}\n\n## Install\nAnother section already called Install.\n`,
      opts,
    );
    expect(codes(text)).not.toContain("doc.section.too-long");
    expect(codes(text)).not.toContain("doc.section.heading.duplicate");
    const doc = parsed(text);
    expect(doc.sections.map((s) => [s.id, s.heading])).toEqual([
      ["setup", "Setup"],
      ["setup-install", "Setup: Install"],
      ["configure", "Configure"],
      ["install", "Install"],
    ]);
    expect(notes).toContain('split "Setup" (454 words) at its ### subheadings into 3 sections');
  });

  test("a section with no subheadings splits into parts at paragraph boundaries", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => prose(150, `p${i}`));
    const { text } = convertDoc(`# Guide\n\n## Notes\n${paragraphs.join("\n\n")}\n`, opts);
    expect(codes(text)).not.toContain("doc.section.too-long");
    const doc = parsed(text);
    expect(doc.sections.map((s) => [s.id, s.heading])).toEqual([
      ["notes", "Notes (Part 1/3)"],
      ["notes-part-2", "Notes (Part 2/3)"],
      ["notes-part-3", "Notes (Part 3/3)"],
    ]);
    // Each paragraph lands whole in one part.
    for (const [i, p] of paragraphs.entries())
      expect(doc.sections[Math.floor(i / 2)]?.body).toContain(p);
  });

  test("never splits inside a code fence or a list", () => {
    const fence = `\`\`\`ts\n${prose(120, "code")}\n\n${prose(120, "more")}\n\`\`\``;
    const list = `- ${prose(100, "a")}\n\n- ${prose(100, "b")}\n  ${prose(30, "c")}\n\n- ${prose(10, "d")}`;
    const { text } = convertDoc(
      `# Guide\n\n## Notes\n${prose(150, "x")}\n\n${fence}\n\n${list}\n\n${prose(20, "end")}\n`,
      opts,
    );
    expect(codes(text)).not.toContain("doc.section.too-long");
    expect(codes(text)).not.toContain("doc.fence.unclosed");
    const bodies = parsed(text).sections.map((s) => s.body);
    expect(bodies.some((b) => b.includes(fence))).toBe(true);
    expect(bodies.some((b) => b.includes(list))).toBe(true);
  });

  test("a single block over the limit stays whole, with a note", () => {
    const { notes } = convertDoc(`# Guide\n\n## Big\n\`\`\`\n${prose(500)}\n\`\`\`\n`, opts);
    expect(notes.join("\n")).toContain('"Big" (502 words) is one code block or list');
  });
});

describe("normalizeDoc", () => {
  const doc = (body: string) =>
    parsed(
      `---\ntitle: Guide\narea: core\nowner: dana\nscope: ["**"]\nupdated: 2026-10-01\n---\n\n${body}`,
    );

  test("leaves a clean document alone", () => {
    const d = doc("Intro.\n\n## A {#a}\nText.\n");
    expect(normalizeDoc(d)).toEqual({ doc: d, changes: [] });
  });

  test("keeps provenance on the sections it makes, and the original id on the first", () => {
    const d = doc(
      `## Notes {#notes}\n<!-- homeostat: source=manual author=dana -->\n${prose(300, "a")}\n\n${prose(300, "b")}\n`,
    );
    const { doc: out, changes } = normalizeDoc(d);
    expect(changes).toEqual(['split "Notes" (600 words) into 2 parts']);
    expect(out.sections.map((s) => s.id)).toEqual(["notes", "notes-part-2"]);
    expect(out.sections.every((s) => s.provenance?.author === "dana")).toBe(true);
    expect(codes(formatDoc(out))).toEqual([]);
  });

  test("with nothing above the first subheading, that subsection stays in the section", () => {
    const d = doc(`## Setup {#setup}\n### Install\n${prose(250)}\n\n### Run\n${prose(250)}\n`);
    const { doc: out } = normalizeDoc(d);
    expect(out.sections.map((s) => s.heading)).toEqual(["Setup", "Run"]);
    expect(out.sections[0]?.body.startsWith("### Install\n")).toBe(true);
  });
});
