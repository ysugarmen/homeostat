import { DOC_SECTION_MAX_WORDS, type Doc, type DocSection } from "./doc.ts";
import { slugify } from "./slug.ts";

/**
 * The mechanical clean-up an imported or hand-written document needs to pass `validate` without
 * the doc.heading.h1 and doc.section.too-long warnings: a body `#` heading is dropped when it
 * repeats the title (which lives in the frontmatter) and becomes a `##` section otherwise; a
 * section over the word limit is split at its `###` subheadings, else at paragraph boundaries
 * into "Part 1/2" sections. Code fences and lists are never split. The text itself is kept as is.
 */
export function normalizeDoc(doc: Doc): { doc: Doc; changes: string[] } {
  const changes: string[] = [];
  const ids = new Set(doc.sections.map((s) => s.id).filter(Boolean));
  const headings = new Set(doc.sections.map((s) => s.heading.toLowerCase()));
  const freshId = (text: string) => {
    const base = (slugify(text) ?? "section").slice(0, 50).replace(/-+$/, "");
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  /** `heading`, or, when another section has it, `parent: heading`, then a number. */
  const freshHeading = (heading: string, parent?: string) => {
    let h = heading;
    if (headings.has(h.toLowerCase()) && parent) h = `${parent}: ${heading}`;
    const base = h;
    for (let n = 2; headings.has(h.toLowerCase()); n++) h = `${base} (${n})`;
    headings.add(h.toLowerCase());
    return h;
  };

  // Body `#` headings: the title repeated is dropped, any other starts a `##` section.
  const title = doc.frontmatter.title.trim().toLowerCase();
  const promote = (text: string, provenance: DocSection["provenance"]) => {
    const { head, parts } = splitAt(text, /^#[ \t]+(.+?)[ \t]*$/);
    let kept = head;
    const added: DocSection[] = [];
    for (const p of parts) {
      if (p.heading.toLowerCase() === title) {
        changes.push(`dropped the # heading "${p.heading}": the title is in the frontmatter`);
        // Its text belongs to whatever came before it.
        const last = added.at(-1);
        if (last) last.body = join(last.body, p.body);
        else kept = join(kept, p.body);
        continue;
      }
      const heading = freshHeading(p.heading);
      changes.push(`# ${p.heading} became the ## section "${heading}"`);
      added.push({
        id: freshId(heading),
        heading,
        line: 0,
        ...(provenance ? { provenance } : {}),
        body: p.body,
      });
    }
    return { head: kept, sections: added };
  };

  const intro = promote(doc.intro, undefined);
  let sections: DocSection[] = [...intro.sections];
  for (const s of doc.sections) {
    const id = s.id || freshId(s.heading);
    if (!s.id) changes.push(`gave "${s.heading}" the id {#${id}}`);
    const p = promote(s.body, s.provenance);
    sections.push({ ...s, id, body: p.head }, ...p.sections);
  }

  // Sections over the limit: at their ### subheadings first, then at paragraph boundaries.
  sections = sections.flatMap((s) => {
    const n = words(s.body);
    if (n <= DOC_SECTION_MAX_WORDS) return [s];
    const { head, parts } = splitAt(s.body, /^###[ \t]+(.+?)[ \t]*$/);
    if (!parts.length) return byParagraph(s);
    const out: DocSection[] = [];
    let rest = parts;
    if (head) out.push({ ...s, body: head });
    else {
      // Nothing above the first subheading: it stays in the section, which keeps its id.
      const [first, ...others] = parts as [Part, ...Part[]];
      out.push({ ...s, body: `### ${first.heading}\n\n${first.body}`.trim() });
      rest = others;
    }
    for (const p of rest) {
      const heading = freshHeading(p.heading, s.heading);
      out.push({
        id: freshId(heading),
        heading,
        line: 0,
        ...(s.provenance ? { provenance: s.provenance } : {}),
        body: p.body,
      });
    }
    changes.push(
      `split "${s.heading}" (${n} words) at its ### subheadings into ${out.length} sections`,
    );
    return out.flatMap(byParagraph);
  });

  function byParagraph(s: DocSection): DocSection[] {
    const n = words(s.body);
    if (n <= DOC_SECTION_MAX_WORDS) return [s];
    const chunks = pack(blocks(s.body));
    if (chunks.length < 2) {
      changes.push(
        `"${s.heading}" (${n} words) is one code block or list; split it by hand if it should be shorter`,
      );
      return [s];
    }
    changes.push(`split "${s.heading}" (${n} words) into ${chunks.length} parts`);
    headings.delete(s.heading.toLowerCase());
    return chunks.map((body, i) => {
      const heading = freshHeading(`${s.heading} (Part ${i + 1}/${chunks.length})`);
      return {
        ...s,
        heading,
        id: i === 0 ? s.id : freshId(`${s.id}-part-${i + 1}`),
        body,
      };
    });
  }

  return { doc: { ...doc, intro: intro.head, sections }, changes };
}

interface Part {
  heading: string;
  body: string;
}

const FENCE = /^\s*(```|~~~)/;
const join = (...texts: string[]) => texts.filter(Boolean).join("\n\n").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Splits `text` at every line `heading` matches outside a code fence. */
function splitAt(text: string, heading: RegExp): { head: string; parts: Part[] } {
  const head: string[] = [];
  const parts: { heading: string; lines: string[] }[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    const h = fence ? null : heading.exec(line);
    if (h) parts.push({ heading: (h[1] ?? "").replace(/\s*\{#[^}]*\}$/, "").trim(), lines: [] });
    else if (parts.length) (parts.at(-1) as { lines: string[] }).lines.push(line);
    else head.push(line);
  }
  return {
    head: head.join("\n").trim(),
    parts: parts.map((p) => ({ heading: p.heading, body: p.lines.join("\n").trim() })),
  };
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * The text's paragraphs: runs of lines between blank lines, where a code fence and a list (with
 * its indented continuation lines, loose or tight) always stay whole.
 */
function blocks(text: string): string[] {
  const lines = text.split("\n");
  const out: string[][] = [[]];
  let fence = false;
  let list = false;
  lines.forEach((line, i) => {
    const current = out.at(-1) as string[];
    if (FENCE.test(line)) {
      fence = !fence;
      current.push(line);
      return;
    }
    if (fence) {
      current.push(line);
      return;
    }
    if (line.trim() === "") {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      const continuesList =
        list && next !== undefined && (LIST_ITEM.test(next) || /^\s/.test(next));
      if (!continuesList && current.length) out.push([]);
      else if (current.length) current.push(line);
      return;
    }
    if (LIST_ITEM.test(line)) list = true;
    else if (!/^\s/.test(line)) list = false;
    current.push(line);
  });
  return out.map((b) => b.join("\n").trim()).filter(Boolean);
}

/** Paragraphs packed in order into chunks under the word limit; a longer paragraph stays whole. */
function pack(paragraphs: string[]): string[] {
  const chunks: string[][] = [];
  let size = 0;
  for (const p of paragraphs) {
    const n = words(p);
    const last = chunks.at(-1);
    if (last && size + n <= DOC_SECTION_MAX_WORDS) {
      last.push(p);
      size += n;
    } else {
      chunks.push([p]);
      size = n;
    }
  }
  return chunks.map((c) => c.join("\n\n"));
}
