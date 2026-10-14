import type { Config } from "./config.ts";
import { type ContextDoc, docRef } from "./doc-context.ts";
import type { Entry } from "./entry.ts";
import type { Event } from "./events.ts";
import { isRejectedDecision } from "./schema.ts";

export interface DigestInput {
  config: Config;
  entries: readonly Entry[];
  docs: readonly ContextDoc[];
  /** Local events, when this runs where sessions log them; CI usually has none. */
  events?: readonly Event[];
  now: Date;
  days?: number;
}

/**
 * The weekly digest (Phase K, K8): what changed in the knowledge base and what needs people,
 * built on the CPU from the KB and, where available, the event log. Slack mrkdwn.
 */
export function buildDigest(input: DigestInput): string {
  const days = input.days ?? 7;
  const since = new Date(input.now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const fm = (e: Entry) => e.frontmatter;
  const isNew = (e: Entry) => fm(e).created >= since;
  const accepted = input.entries.filter((e) => fm(e).status === "accepted");
  const added = accepted.filter((e) => isNew(e) && !isRejectedDecision(fm(e)));
  const confirmed = accepted.filter((e) => !isNew(e) && fm(e).lastConfirmed >= since);
  const rejected = accepted.filter((e) => isNew(e) && isRejectedDecision(fm(e)));
  const queue = input.entries.filter(
    (e) => fm(e).status === "candidate" || fm(e).status === "disputed",
  );
  const flags = input.entries.flatMap((e) =>
    (fm(e).flags ?? []).filter((f) => f.date >= since).map((f) => ({ id: fm(e).id, ...f })),
  );
  const sections = input.docs.flatMap(({ path, doc }) =>
    doc.sections
      .filter((s) => (s.provenance?.updated ?? "") >= since)
      .map((s) => `${docRef(path)}#${s.id}`),
  );
  const guesses = new Map<string, number>();
  for (const e of input.events ?? []) {
    if ((e.type === "mcp-unknown-tool" || e.type === "mcp-alias") && e.ts.slice(0, 10) >= since) {
      const name = String(e.name);
      guesses.set(name, (guesses.get(name) ?? 0) + 1);
    }
  }
  const top = [...guesses].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const list = <T>(items: readonly T[], line: (t: T) => string, max = 8) =>
    items.length
      ? [
          ...items.slice(0, max).map((t) => `• ${line(t)}`),
          ...(items.length > max ? [`• …and ${items.length - max} more`] : []),
        ]
      : [];
  const section = (title: string, lines: string[]) =>
    lines.length ? [`*${title}*`, ...lines, ""] : [];
  const rule = (e: Entry) => `${fm(e).title} (\`${fm(e).id}\`, ${fm(e).area})`;

  const body = [
    ...section(`New rules (${added.length})`, list(added, rule)),
    ...section(`Reconfirmed (${confirmed.length})`, list(confirmed, rule)),
    ...section(`Decided against (${rejected.length})`, list(rejected, rule)),
    ...section(
      `Document sections updated (${sections.length})`,
      list(sections, (s) => `\`${s}\``),
    ),
    ...section(
      `Waiting for review (${queue.length})`,
      list(queue, (e) => `${rule(e)} — ${fm(e).status}`),
    ),
    ...section(
      `Flagged as wrong (${flags.length})`,
      list(flags, (f) => `\`${f.id}\` by ${f.by}: ${f.reason}`),
    ),
    ...section(
      "Tool names agents guessed",
      list(top, ([n, c]) => `\`${n}\` ×${c}`, 5),
    ),
  ];
  const quiet = body.length === 0;
  return [
    `*Homeostat weekly digest* (since ${since})`,
    "",
    ...(quiet ? ["A quiet week: no new or changed rules, documents, reviews or flags."] : body),
  ]
    .join("\n")
    .trimEnd();
}
