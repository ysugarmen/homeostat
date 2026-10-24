/**
 * What a session is told about looking things up in the KB, and how to credit what it used.
 *
 * Measured by vectorize-io/hindsight on real Claude Code sessions (their coding-agents eval,
 * MIT): listing page titles up front made agents read only what was listed and never search;
 * a count plus "search, then read" fixed that; repeating a short guide on every prompt doubled
 * the search rate; and naming concrete moments to look things up raised it again, far more than
 * describing a category. The wording here is our own, adapted to rules and documents.
 */

/** The fixed attribution an agent puts above a part of its reply that used Homeostat knowledge. */
export const CREDIT_LABEL = "From Homeostat";

/** The moments that go wrong silently without the team's knowledge, for coding work. */
export const TRIGGER_MOMENTS = [
  "the user reports a bug or a wrong behaviour",
  "you are about to write or change a test",
  "you are implementing something new, or making two parts fit together",
  "the user asks why something is the way it is, or what is left to do",
  "you are about to commit",
] as const;

/** The tools that hand knowledge back to the agent; a credit can only follow one of these. */
export const RETRIEVAL_TOOLS = new Set(["context", "search", "explain", "docs", "read", "list"]);

const counts = (byGroup: ReadonlyMap<string, number>) =>
  [...byGroup].map(([g, n]) => `${g} ${n}`).join(", ");

/**
 * The session-start guide: how to look things up, when, and how to credit it. `rules` and `docs`
 * are what the session was not given in full, by topic or area; they are counted, never listed,
 * so the first call is a search rather than a pick from a list. `compact` keeps the counts and
 * the one-line prompt reminder, for a token budget too small for the whole guide.
 */
export function sessionGuide(opts: {
  rules: ReadonlyMap<string, number>;
  docs: ReadonlyMap<string, number>;
  compact?: boolean;
}): string {
  const ruleTotal = [...opts.rules.values()].reduce((a, b) => a + b, 0);
  const docTotal = [...opts.docs.values()].reduce((a, b) => a + b, 0);
  const have = [
    ...(ruleTotal
      ? [
          `- ${ruleTotal} more team rule${ruleTotal === 1 ? "" : "s"} apply here but are not shown (${counts(opts.rules)}).`,
        ]
      : []),
    ...(docTotal
      ? [
          `- ${docTotal} team document${docTotal === 1 ? "" : "s"} cover this code (${counts(opts.docs)}).`,
        ]
      : []),
  ];
  if (opts.compact) {
    return ["# Looking things up (homeostat)", ...have, PROMPT_GUIDE].join("\n");
  }
  return [
    "# Looking things up (homeostat)",
    ...(have.length
      ? [`${have.join("\n")}\nThey are not listed here: search for what you need.`]
      : []),
    [
      "Homeostat MCP tools:",
      "- `context` with the files you will change: the rules for them.",
      "- `search` with a subject: matching rules and document sections, best first.",
      "- `docs`, then `read` with a document and section id: the section's text.",
      "- `explain` with a rule id: why the rule exists.",
    ].join("\n"),
    `Look it up before you act when:\n${TRIGGER_MOMENTS.map((m) => `- ${m}`).join("\n")}`,
    `When a rule or document shaped part of your reply, start that part with \`> ${CREDIT_LABEL} (<rule-id or area/topic#section>)\`. Nothing used, no line.`,
  ].join("\n\n");
}

/** The short reminder added to every prompt; well under 80 tokens. */
export const PROMPT_GUIDE = `Homeostat: on a bug report, a test, new code, a why or what's-left question, or a commit, first call \`search\` (or \`context\` with the files). Credit what you use: \`> ${CREDIT_LABEL} (<id>)\`.`;

const CREDIT_RE =
  /^[ \t]*>[ \t]*(?:\*\*)?[ \t]*From Homeostat[ \t]*(?:\*\*)?[ \t]*\(([^)\n]{1,400})\)/gim;
/** A rule id, or `area/topic` with an optional `#section`. */
const ID_RE = /^[a-z0-9][a-z0-9._/-]{0,119}(?:#[a-z0-9][a-z0-9._-]{0,79})?$/i;

/**
 * The ids credited in an agent's reply: every `> From Homeostat (a, b#c)` line. Only id-shaped
 * tokens come back (lowercased, deduplicated); anything else counts in `other`, never as text.
 */
export function parseCredits(text: string): { ids: string[]; other: number; lines: number } {
  const ids = new Set<string>();
  let other = 0;
  let lines = 0;
  for (const m of text.matchAll(CREDIT_RE)) {
    lines++;
    for (const raw of (m[1] ?? "").split(/[,;]|\s+and\s+/)) {
      const id = raw.trim().replace(/^`|`$/g, "");
      if (!id) continue;
      if (ID_RE.test(id)) ids.add(id.toLowerCase());
      else other++;
    }
  }
  return { ids: [...ids], other, lines };
}
