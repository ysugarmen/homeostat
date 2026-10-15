import type { Config } from "./config.ts";
import { detectConflicts } from "./conflicts.ts";
import type { ContextDoc } from "./doc-context.ts";
import type { Entry } from "./entry.ts";
import type { Event } from "./events.ts";
import { isRejectedDecision } from "./schema.ts";
import { score } from "./score.ts";
import { sectionUsage } from "./section-usage.ts";

/** One entry in full, for `explain`: status, score breakdown, source, history and the text. */
export function explainEntry(e: Entry, config: Config): string {
  const fm = e.frontmatter;
  const reasons = score(fm, { config }).reasons.map(
    (r) => `${r.delta > 0 ? "+" : ""}${r.delta} ${r.note}`,
  );
  const lines = [
    `# ${fm.title} (${fm.id})`,
    `Status: ${fm.status} · score ${fm.score} (${reasons.join(", ") || "no signals"}) · owner ${fm.owner} · area ${fm.area}`,
    ...(isRejectedDecision(fm)
      ? [
          "Decision: considered and NOT adopted. Do not propose it again unless something below no longer holds.",
        ]
      : fm.kind
        ? [`Kind: ${fm.kind}${fm.kind === "decision" ? " (adopted)" : ""}`]
        : []),
    `Applies to: ${fm.scope.join(", ")}`,
    `Source: ${fm.source.type} by ${fm.source.author}${fm.source.url ? ` — ${fm.source.url}` : ""}${fm.source.changedCode ? " (code changed after the comment)" : ""}`,
    `Created ${fm.created}, last confirmed ${fm.lastConfirmed}${fm.approvedBy ? `, approved by ${fm.approvedBy}` : ""}`,
    ...(fm.conflictsWith?.length ? [`Conflicts with: ${fm.conflictsWith.join(", ")}`] : []),
    ...(fm.supersedes ? [`Supersedes: ${fm.supersedes}`] : []),
    ...(fm.flags ?? []).map((f) => `Flagged by ${f.by} on ${f.date}: ${f.reason}`),
    "",
    `${isRejectedDecision(fm) ? "Proposal" : "Rule"}: ${e.sections.rule ?? ""}`,
    "",
    `${isRejectedDecision(fm) ? "Why not" : "Why"}: ${e.sections.why ?? ""}`,
    ...(e.sections.example ? ["", e.sections.example] : []),
  ];
  return lines.join("\n");
}

/** One line per search hit: id, title, area, score, then the rule. */
export const hitLine = (e: Entry): string =>
  isRejectedDecision(e.frontmatter)
    ? `- ${e.frontmatter.id}: ${e.frontmatter.title} [${e.frontmatter.area}, considered and not adopted]\n  Not adopted: ${e.sections.rule ?? ""} Why not: ${e.sections.why ?? ""}`
    : `- ${e.frontmatter.id}: ${e.frontmatter.title} [${e.frontmatter.area}${e.frontmatter.kind ? `, ${e.frontmatter.kind}` : ""}, score ${e.frontmatter.score}]\n  ${e.sections.rule ?? ""}`;

function documentsLine(
  docs: readonly ContextDoc[],
  events: readonly Record<string, unknown>[],
  now: Date,
): string {
  const usage = sectionUsage(docs, events as Event[], now);
  const review = usage.filter((u) => u.decaying);
  return `- Documents: ${docs.length} (${usage.length} sections; ${review.length} unused and unconfirmed for 90 days${review.length ? `: ${review.map((u) => `${u.doc}#${u.id}`).join(", ")}` : ""})`;
}

/** KB health over the last `days`, from the entries and the event log. */
export function kbReport(
  entries: readonly Entry[],
  config: Config,
  opts: {
    days: number;
    now: Date;
    events?: readonly Record<string, unknown>[];
    docs?: readonly ContextDoc[];
  },
): string {
  const days = opts.days;
  const now = opts.now;
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const staleBefore = new Date(now.getTime() - config.agents.deepDive.staleAfterDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const byStatus = new Map<string, number>();
  for (const e of entries)
    byStatus.set(e.frontmatter.status, (byStatus.get(e.frontmatter.status) ?? 0) + 1);
  const fresh = entries.filter((e) => e.frontmatter.created >= since);
  const flagged = entries.filter((e) => e.frontmatter.flags?.length);
  const stale = entries.filter(
    (e) => e.frontmatter.status === "accepted" && e.frontmatter.lastConfirmed < staleBefore,
  );
  const duplicates = detectConflicts(entries.map((e) => e.frontmatter)).filter(
    (c) => c.kind === "possible-duplicate",
  );
  const events = (opts.events ?? []).filter(
    (e) => typeof e.ts === "string" && e.ts.slice(0, 10) >= since,
  );
  const injections = events.filter((e) => e.type === "injection").length;
  const unknown = events.filter(
    (e) => e.type === "mcp-unknown-tool" || e.type === "mcp-alias",
  ).length;

  return [
    `Knowledge base, last ${days} days (since ${since}):`,
    `- Entries: ${entries.length} (${[...byStatus].map(([s, n]) => `${n} ${s}`).join(", ") || "none"})`,
    `- New: ${fresh.length}${fresh.length ? ` (${fresh.map((e) => e.frontmatter.id).join(", ")})` : ""}`,
    `- Flagged: ${flagged.length}${flagged.length ? ` (${flagged.map((e) => e.frontmatter.id).join(", ")})` : ""}`,
    `- Disputed: ${byStatus.get("disputed") ?? 0}`,
    `- Stale (not confirmed in ${config.agents.deepDive.staleAfterDays} days): ${stale.length}`,
    `- Possible duplicates: ${duplicates.length}`,
    `- Rule injections into sessions: ${injections}`,
    `- Guessed tool names logged: ${unknown}`,
    ...(opts.docs?.length ? [documentsLine(opts.docs, opts.events ?? [], now)] : []),
  ].join("\n");
}
