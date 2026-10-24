import { type DocSection, parseDoc } from "./doc.ts";
import { applySectionPatch, PatchError, type SectionPatch } from "./doc-patch.ts";

const same = (a: DocSection | undefined, b: DocSection | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.heading === b.heading &&
  a.body === b.body &&
  JSON.stringify(a.provenance ?? {}) === JSON.stringify(b.provenance ?? {});

/**
 * Three-way merge of a document, section by section, for rebuilding a review PR on a base that
 * moved: the base's text (`ours`) is kept byte for byte, and the PR's section changes are applied
 * on top. A section both sides changed is combined only when both kept the old text and added to
 * its end; the later provenance wins. Anything else is a conflict, listed by section id.
 */
export function mergeDocText(
  was: string | undefined,
  ours: string,
  theirs: string,
): { text: string; conflicts: [] } | { text?: undefined; conflicts: string[] } {
  const w = parseDoc(was ?? "").doc;
  const o = parseDoc(ours).doc;
  const t = parseDoc(theirs).doc;
  if (!o || !t) return { conflicts: ["the whole document"] };
  const base = new Map((w?.sections ?? []).map((s) => [s.id, s]));
  const mine = new Map(o.sections.map((s) => [s.id, s]));
  const conflicts: string[] = [];
  if (t.intro !== (w?.intro ?? "") && t.intro !== o.intro) conflicts.push("intro");
  for (const id of base.keys())
    if (!t.sections.some((s) => s.id === id) && mine.has(id)) conflicts.push(id);

  const patches: SectionPatch[] = [];
  for (const ts of t.sections) {
    const ws = base.get(ts.id);
    const os = mine.get(ts.id);
    const provenance = ts.provenance ?? { source: "manual" };
    if (same(ts, ws) || same(ts, os)) continue;
    if (!os) {
      if (ws) conflicts.push(ts.id);
      else patches.push({ op: "add", id: ts.id, heading: ts.heading, body: ts.body, provenance });
    } else if (ws && same(os, ws)) {
      patches.push({ op: "replace", id: ts.id, heading: ts.heading, body: ts.body, provenance });
    } else if (
      ws &&
      os.heading === ts.heading &&
      os.body.startsWith(ws.body) &&
      ts.body.startsWith(ws.body) &&
      ts.body.length > ws.body.length
    ) {
      const later =
        (os.provenance?.updated ?? "") > (ts.provenance?.updated ?? "")
          ? os.provenance
          : provenance;
      patches.push({
        op: "append",
        id: ts.id,
        body: ts.body.slice(ws.body.length).trim(),
        provenance: later ?? provenance,
      });
    } else {
      conflicts.push(ts.id);
    }
  }
  if (conflicts.length) return { conflicts };

  const updated = [o.frontmatter.updated, t.frontmatter.updated].sort().at(-1) ?? "";
  let text = ours;
  try {
    for (const p of patches) text = applySectionPatch(text, p, updated);
  } catch (e) {
    if (e instanceof PatchError) return { conflicts: [e.message] };
    throw e;
  }
  return { text, conflicts: [] };
}
