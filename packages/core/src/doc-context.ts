import type { Doc } from "./doc.ts";
import { globMatch } from "./select.ts";
import { countTokens } from "./tokens.ts";

export interface ContextDoc {
  path: string;
  doc: Doc;
}

export interface DocContext {
  text: string;
  /** The documents listed in the index, by `<area>/<topic>`. */
  listed: string[];
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

/**
 * What a session gets of the documents: a short index of those covering the touched paths (plus
 * org-wide ones), and the full text of the sections that name a touched path, best first, within
 * the budget. Documents are too big to inject whole; agents read the rest on demand (Phase K, K6).
 */
export function docContext(
  docs: readonly ContextDoc[],
  paths: readonly string[],
  opts: { tokenBudget: number; maxChars: number; readHint: string },
): DocContext {
  const relevant = docs.filter(({ doc }) => {
    const scope = doc.frontmatter.scope;
    return (
      scope.some((g) => GLOBAL.has(g)) || paths.some((p) => scope.some((g) => globMatch(p, g)))
    );
  });
  if (relevant.length === 0) return { text: "", listed: [], sections: [] };

  const fits = (text: string) =>
    text.length <= opts.maxChars && countTokens(text) <= opts.tokenBudget;
  // Every document by title first (as many as fit), then section ids for each while they fit:
  // one long document must not push the others out of the index.
  const head = [
    "# Team documents (homeostat)",
    `Reference documents for the code in this session. ${opts.readHint}`,
  ].join("\n");
  const line = (d: ContextDoc, ids: boolean) => {
    const base = `- ${d.doc.frontmatter.title} (${docRef(d.path)})`;
    const list = d.doc.sections.filter((s) => s.id).map((s) => s.id);
    return ids && list.length > 0 ? `${base}: ${list.join(", ")}` : base;
  };
  const listed: ContextDoc[] = [];
  const lines: string[] = [];
  for (const d of relevant) {
    if (!fits([head, ...lines, line(d, false)].join("\n"))) break;
    listed.push(d);
    lines.push(line(d, false));
  }
  for (const [i, d] of listed.entries()) {
    const full = line(d, true);
    if (fits([head, ...lines.with(i, full)].join("\n"))) lines[i] = full;
  }
  const index = [head, ...lines].join("\n");
  if (listed.length === 0) return { text: "", listed: [], sections: [] };

  // Touched paths share folders, so the same needle repeats; each is searched for once.
  const wanted = [...new Set(paths.flatMap(needles))];
  const scored = listed
    .flatMap(({ path, doc }) =>
      doc.sections.map((s) => ({
        doc: docRef(path),
        s,
        hits: wanted.filter((n) => s.body.includes(n)).length,
      })),
    )
    .filter((x) => x.hits > 0 && x.s.id)
    .sort((a, b) => b.hits - a.hits || a.doc.localeCompare(b.doc));

  let text = index;
  const sections: DocContext["sections"] = [];
  for (const { doc, s } of scored) {
    const next = `${text}\n\n## ${s.heading} (${doc}#${s.id})\n${s.body}`;
    if (!fits(next)) continue;
    text = next;
    sections.push({ doc, id: s.id });
  }
  return { text, listed: listed.map((d) => docRef(d.path)), sections };
}
