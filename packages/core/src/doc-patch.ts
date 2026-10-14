import { formatProvenance, type Provenance, parseDoc } from "./doc.ts";

/**
 * Section-level edits to a document. Whole-file rewrites caused most of the pilot's damage
 * (duplicated headings, lost sections, conflict markers), so agents and people change one section
 * at a time: every byte outside that section is kept as it was (Phase K, K4).
 */
export type SectionPatch =
  | { op: "replace"; id: string; body: string; provenance: Provenance; heading?: string }
  | { op: "append"; id: string; body: string; provenance: Provenance }
  | { op: "add"; id: string; heading: string; body: string; provenance: Provenance };

export class PatchError extends Error {}

const HEADING = /^##[ \t]+(.+?)(?:[ \t]+\{#([^}\s]+)\})?[ \t]*$/;

/** Line ranges of each `##` section, outside code fences: [start, end) in line numbers. */
function sectionRanges(
  lines: string[],
): { id: string; heading: string; start: number; end: number }[] {
  const out: { id: string; heading: string; start: number; end: number }[] = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : HEADING.exec(line);
    if (h) {
      const last = out.at(-1);
      if (last) last.end = i;
      out.push({ id: h[2] ?? "", heading: (h[1] ?? "").trim(), start: i, end: lines.length });
    }
  });
  return out;
}

/** Applies one patch and bumps `updated` in the frontmatter; throws when it cannot apply cleanly. */
export function applySectionPatch(text: string, patch: SectionPatch, today: string): string {
  const lines = text.split("\n");
  const ranges = sectionRanges(lines);
  const target = ranges.find((r) => r.id === patch.id);
  const block = (heading: string) => [
    `## ${heading} {#${patch.id}}`,
    formatProvenance(patch.provenance),
    patch.body.trim(),
    "",
  ];

  let next: string[];
  if (patch.op === "add") {
    if (target)
      throw new PatchError(`section "${patch.id}" already exists; replace or append to it`);
    if (ranges.some((r) => r.heading.toLowerCase() === patch.heading.toLowerCase())) {
      throw new PatchError(`a section is already headed "${patch.heading}"`);
    }
    const body = lines.join("\n").replace(/\n*$/, "");
    next = [...body.split("\n"), "", ...block(patch.heading)];
  } else {
    if (!target) throw new PatchError(`no section with id "${patch.id}"`);
    const old = lines.slice(target.start, target.end);
    // Keep the blank lines that separated this section from the next one.
    let trailing = 0;
    while (trailing < old.length - 1 && old[old.length - 1 - trailing]?.trim() === "") trailing++;
    let replacement: string[];
    if (patch.op === "replace") {
      replacement = block(patch.heading ?? target.heading).slice(0, -1);
    } else {
      // Keep the heading and the old text; the new provenance replaces the one under the heading.
      const bodyStart = /^<!--\s*homeostat:/.test(old[1] ?? "") ? 2 : 1;
      const kept = old.slice(bodyStart, old.length - trailing);
      replacement = [
        old[0] ?? "",
        formatProvenance(patch.provenance),
        ...kept,
        "",
        patch.body.trim(),
      ];
    }
    next = [
      ...lines.slice(0, target.start),
      ...replacement,
      ...Array(trailing).fill(""),
      ...lines.slice(target.end),
    ];
  }

  const out = next.join("\n").replace(/^(---\n[\s\S]*?\nupdated: )\S+/, `$1${today}`);
  const parsed = parseDoc(out);
  const broken = parsed.issues.filter(
    (i) => i.severity === "error" && !parseDoc(text).issues.some((o) => o.code === i.code),
  );
  if (!parsed.doc || broken.length) {
    throw new PatchError(
      `the patch would break the document: ${broken.map((i) => i.message).join("; ")}`,
    );
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Which sections differ between two versions of a document, by id. */
export function changedSections(before: string, after: string): string[] {
  const a = parseDoc(before).doc;
  const b = parseDoc(after).doc;
  if (!a || !b) return [];
  const key = (s: { heading: string; body: string; provenance?: unknown }) =>
    JSON.stringify([s.heading, s.body, s.provenance]);
  const old = new Map(a.sections.map((s) => [s.id, key(s)]));
  const ids = new Set([...a.sections.map((s) => s.id), ...b.sections.map((s) => s.id)]);
  return [...ids].filter((id) => {
    const now = b.sections.find((s) => s.id === id);
    return !now || old.get(id) !== key(now);
  });
}
