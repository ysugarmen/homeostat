import type { Doc } from "./doc.ts";
import { globMatch } from "./select.ts";
import { countTokens } from "./tokens.ts";

export interface ContextDoc {
  path: string;
  doc: Doc;
}

export interface DocContext {
  /** The sections that name a touched path, in full; empty when none does or none fits. */
  text: string;
  /** The documents covering the session, by `<area>/<topic>`: the session is told their count. */
  listed: string[];
  /** Those documents counted by area, most first. */
  byArea: Map<string, number>;
  /** The sections included in full. */
  sections: { doc: string; id: string }[];
}

/**
 * `integrations/partner-calls` for knowledge/integrations/docs/partner-calls.md, and
 * `api/integrations/partner-calls` for a repo's knowledge/api/integrations/docs/partner-calls.md.
 */
export const docRef = (path: string) => {
  const m = /^knowledge\/(.+?)\/docs\/(.+)\.md$/.exec(path);
  return m ? `${m[1]}/${m[2]}` : path;
};

const GLOBAL = new Set(["**", "**/*"]);

/** Whether a document's scope covers a repo-relative path. */
export const docCovers = (doc: Doc, path: string) =>
  doc.frontmatter.scope.some((g) => globMatch(path, g));

/** Words in a touched path that a section naming it would contain: the path, its folder, its file stem. */
function needles(path: string): string[] {
  const parts = path.split("/");
  const file = parts.at(-1) ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  const dir = parts.slice(0, -1).join("/");
  return [path, ...(dir ? [dir] : []), ...(stem.length >= 4 ? [stem] : [])];
}

const DOC_HEAD = "# Team document sections for your files (homeostat)";

/**
 * What a session gets of the documents: the full text of the sections that name a touched path,
 * best first, within the budget, and a count of the documents covering the touched paths (plus
 * org-wide ones). Documents are not listed by title: agents find the rest with `search` or
 * `docs` and open them with `read` (see guide.ts for why a list suppresses searching).
 */
export function docContext(
  docs: readonly ContextDoc[],
  paths: readonly string[],
  opts: { tokenBudget: number; maxChars: number },
): DocContext {
  const relevant = docs.filter(({ doc }) => {
    const scope = doc.frontmatter.scope;
    return (
      scope.some((g) => GLOBAL.has(g)) || paths.some((p) => scope.some((g) => globMatch(p, g)))
    );
  });
  const byArea = new Map<string, number>();
  for (const { doc } of relevant) {
    byArea.set(doc.frontmatter.area, (byArea.get(doc.frontmatter.area) ?? 0) + 1);
  }
  const sorted = new Map([...byArea].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const listed = relevant.map((d) => docRef(d.path));
  if (relevant.length === 0) return { text: "", listed, byArea: sorted, sections: [] };

  const fits = (text: string) =>
    text.length <= opts.maxChars && countTokens(text) <= opts.tokenBudget;
  // Touched paths share folders, so the same needle repeats; each is searched for once.
  const wanted = [...new Set(paths.flatMap(needles))];
  const scored = relevant
    .flatMap(({ path, doc }) =>
      doc.sections.map((s) => ({
        doc: docRef(path),
        s,
        hits: wanted.filter((n) => s.body.includes(n)).length,
      })),
    )
    .filter((x) => x.hits > 0 && x.s.id)
    .sort((a, b) => b.hits - a.hits || a.doc.localeCompare(b.doc));

  let text = DOC_HEAD;
  const sections: DocContext["sections"] = [];
  for (const { doc, s } of scored) {
    const next = `${text}\n\n## ${s.heading} (${doc}#${s.id})\n${s.body}`;
    if (!fits(next)) continue;
    text = next;
    sections.push({ doc, id: s.id });
  }
  return { text: sections.length ? text : "", listed, byArea: sorted, sections };
}
