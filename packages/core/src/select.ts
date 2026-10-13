import { minimatch } from "minimatch";
import type { Entry } from "./entry.ts";
import { countTokens } from "./tokens.ts";

export const CONTEXT_HEADER = `# Team knowledge (homeostat)

These rules come from your team's reviewed knowledge base and apply to the files in this session. Follow them; if one looks wrong for the case at hand, say so and suggest /homeostat:explain <id>.`;

export interface SelectOptions {
  /** Repo-relative paths the session is likely to touch. */
  paths: readonly string[];
  tokenBudget: number;
  /** Hard cap on rendered characters, e.g. Claude Code's 10,000 for SessionStart context. */
  maxChars?: number;
}

export interface SelectedEntry {
  entry: Entry;
  /** `full` is Rule, Why and Example; `rule` is the Rule alone, used when the budget is tight. */
  form: "full" | "rule";
}

export interface Selection {
  items: SelectedEntry[];
  /** Ids that applied but did not fit the budget even as a bare Rule. */
  dropped: string[];
  /** Tokens of the rendered context. */
  tokens: number;
}

const isGlobalGlob = (glob: string) => glob === "**" || glob === "**/*";
const isGlobal = (scope: readonly string[]) => scope.some(isGlobalGlob);

const matches = (path: string, scope: readonly string[]) =>
  scope.some((glob) => minimatch(path, glob, { dot: true }));

function block({ entry, form }: SelectedEntry): string {
  const { frontmatter: fm, sections } = entry;
  const head = `## ${fm.title} (${fm.id})\n${sections.rule ?? ""}`;
  if (form === "rule") return head;
  return [head, `Why: ${sections.why ?? ""}`, ...(sections.example ? [sections.example] : [])].join(
    "\n\n",
  );
}

export function renderContext(selection: Pick<Selection, "items">): string {
  if (selection.items.length === 0) return "";
  return [CONTEXT_HEADER, ...selection.items.map(block)].join("\n\n");
}

/**
 * Picks the accepted entries relevant to `paths`, best first, within the token budget. Ranking
 * is score, then path matches before global entries, then most recently confirmed. Each entry is
 * taken whole if it fits, else as its Rule alone, else dropped.
 */
export function selectEntries(entries: readonly Entry[], opts: SelectOptions): Selection {
  const relevant = entries
    .filter((e) => e.frontmatter.status === "accepted")
    .map((e) => {
      // A global glob matches every path, so only narrower globs count as a path match.
      const narrow = e.frontmatter.scope.filter((g) => !isGlobalGlob(g));
      const specific = opts.paths.some((p) => matches(p, narrow));
      return { e, specific, applies: specific || isGlobal(e.frontmatter.scope) };
    })
    .filter((r) => r.applies)
    .sort(
      (a, b) =>
        b.e.frontmatter.score - a.e.frontmatter.score ||
        Number(b.specific) - Number(a.specific) ||
        b.e.frontmatter.lastConfirmed.localeCompare(a.e.frontmatter.lastConfirmed) ||
        a.e.frontmatter.id.localeCompare(b.e.frontmatter.id),
    );

  const items: SelectedEntry[] = [];
  const dropped: string[] = [];
  let tokens = 0;
  for (const { e } of relevant) {
    const remaining = opts.tokenBudget - tokens;
    // The cached `tokens` field rules out the full form cheaply; the final count is exact.
    const forms: SelectedEntry["form"][] =
      e.frontmatter.tokens <= remaining ? ["full", "rule"] : ["rule"];
    const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY;
    const fit = forms
      .map((form) => {
        const text = renderContext({ items: [...items, { entry: e, form }] });
        return { form, total: text.length <= maxChars ? countTokens(text) : Number.NaN };
      })
      .find(({ total }) => total <= opts.tokenBudget);
    if (fit) {
      items.push({ entry: e, form: fit.form });
      tokens = fit.total;
    } else {
      dropped.push(e.frontmatter.id);
    }
  }
  return { items, dropped, tokens };
}
