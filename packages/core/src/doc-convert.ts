import { type Doc, type DocSection, formatDoc, type Provenance, parseProvenance } from "./doc.ts";
import { slugify } from "./slug.ts";

export interface ConvertOptions {
  area: string;
  owner: string;
  scope: string[];
  /** Used when the document carries no date of its own. */
  today: string;
  /** Title when the document has no `#` heading. */
  fallbackTitle: string;
}

const DATE = /\d{4}-\d{2}-\d{2}/;
const UPDATED_LINE =
  /^\s*(?:<!--\s*)?(?:\*\*)?last updated:?(?:\*\*)?\s*:?\s*(\d{4}-\d{2}-\d{2})?.*?(?:-->)?\s*$/i;
const EVIDENCE = /^\s*<!--\s*EVIDENCE:\s*(.*?)\s*-->\s*$/i;

/**
 * Turns a plain markdown document (a `#` title, `##` sections, "Last updated" lines, EVIDENCE
 * comments) into a Homeostat document: frontmatter, `{#id}` on every section, and per-section
 * provenance. It fixes only what is mechanical; real defects such as two sections with the same
 * heading are kept, so `validate` reports them for a person to merge.
 */
export function convertDoc(text: string, opts: ConvertOptions): { text: string; notes: string[] } {
  const notes: string[] = [];
  let body = text.replace(/\r\n/g, "\n").trim();
  const wrapped = /^(```|~~~)[^\n]*\n([\s\S]*)\n\1\s*$/.exec(body);
  if (wrapped) {
    body = wrapped[2] ?? "";
    notes.push("removed a code fence wrapping the whole document");
  }

  const dates: string[] = [];
  let title = opts.fallbackTitle;
  const kept: string[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && UPDATED_LINE.test(line)) {
      const d = DATE.exec(line)?.[0];
      if (d) dates.push(d);
      continue;
    }
    const h1 = fence ? null : /^#\s+(.+?)\s*$/.exec(line);
    if (h1 && title === opts.fallbackTitle) {
      title = h1[1] ?? title;
      continue;
    }
    kept.push(line);
  }
  if (dates.length > 1) notes.push(`merged ${dates.length} "Last updated" lines into updated`);
  const updated = dates.sort().at(-1) ?? opts.today;

  // Split into intro and ## sections, outside code fences.
  const intro: string[] = [];
  const raw: { heading: string; lines: string[] }[] = [];
  fence = false;
  for (const line of kept) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (h) raw.push({ heading: (h[1] ?? "").replace(/\s*\{#[^}]+\}$/, ""), lines: [] });
    else if (raw.length) (raw.at(-1) as { lines: string[] }).lines.push(line);
    else intro.push(line);
  }

  const used = new Set<string>();
  const sections: DocSection[] = raw.map(({ heading, lines }) => {
    const base = slugify(heading) ?? "section";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 56)}-${n}`;
    used.add(id);
    let provenance: Provenance = { source: "imported", updated };
    const evidence: string[] = [];
    const rest = lines.filter((l) => {
      const ev = EVIDENCE.exec(l);
      if (ev) {
        evidence.push(ev[1] ?? "");
        return false;
      }
      const prov = /^\s*<!--\s*homeostat:\s*(.*?)\s*-->\s*$/.exec(l);
      if (prov) {
        provenance = parseProvenance(prov[1] ?? "") ?? provenance;
        return false;
      }
      return true;
    });
    if (evidence.length) provenance = { ...provenance, note: evidence.join("; ") };
    return { id, heading, line: 0, provenance, body: rest.join("\n").trim() };
  });
  const titles = new Map<string, number>();
  for (const s of sections)
    titles.set(s.heading.toLowerCase(), (titles.get(s.heading.toLowerCase()) ?? 0) + 1);
  for (const [h, n] of titles)
    if (n > 1) notes.push(`heading "${h}" appears ${n} times; validate will ask you to merge them`);

  const doc: Doc = {
    frontmatter: {
      title: title.slice(0, 80),
      area: opts.area,
      owner: opts.owner,
      scope: opts.scope,
      updated,
    },
    intro: intro.join("\n").trim(),
    sections,
  };
  return { text: formatDoc(doc), notes };
}
