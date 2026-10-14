import type { ContextDoc } from "./doc-context.ts";
import { docRef } from "./doc-context.ts";
import type { Event } from "./events.ts";

export interface SectionUsage {
  doc: string;
  id: string;
  heading: string;
  /** `read` calls for this section, or for the whole document. */
  reads: number;
  /** Sessions it was put into in full. */
  injected: number;
  lastUsed?: string;
  /** When its text was last written or confirmed (its provenance, else the document's date). */
  confirmed: string;
  /** Unused and unconfirmed for the decay window: a review candidate, never deleted for it. */
  decaying: boolean;
}

const DAY = 86_400_000;

/**
 * How much each document section is used, from this machine's event log (Phase K, K7). A section
 * nobody has read or been given in `decayDays`, and nobody has confirmed in that time, becomes a
 * review candidate: its owner confirms it, updates it, or removes it.
 */
export function sectionUsage(
  docs: readonly ContextDoc[],
  events: readonly Event[],
  now: Date,
  decayDays = 90,
): SectionUsage[] {
  const cutoff = new Date(now.getTime() - decayDays * DAY).toISOString();
  const rows: SectionUsage[] = docs.flatMap(({ path, doc }) =>
    doc.sections
      .filter((s) => s.id)
      .map((s) => ({
        doc: docRef(path),
        id: s.id,
        heading: s.heading,
        reads: 0,
        injected: 0,
        confirmed: s.provenance?.updated ?? doc.frontmatter.updated,
        decaying: false,
      })),
  );
  const byKey = new Map(rows.map((r) => [`${r.doc}#${r.id}`, r]));
  const touch = (r: SectionUsage | undefined, ts: string, field: "reads" | "injected") => {
    if (!r) return;
    r[field]++;
    if (!r.lastUsed || ts > r.lastUsed) r.lastUsed = ts;
  };
  for (const e of events) {
    if (e.type === "doc-read" && typeof e.doc === "string") {
      if (typeof e.section === "string") touch(byKey.get(`${e.doc}#${e.section}`), e.ts, "reads");
      else for (const r of rows.filter((x) => x.doc === e.doc)) touch(r, e.ts, "reads");
    } else if (e.type === "doc-injection" && Array.isArray(e.sections)) {
      for (const s of e.sections as { doc: string; id: string }[]) {
        touch(byKey.get(`${s.doc}#${s.id}`), e.ts, "injected");
      }
    }
  }
  for (const r of rows) {
    r.decaying = (!r.lastUsed || r.lastUsed < cutoff) && r.confirmed < cutoff.slice(0, 10);
  }
  return rows.sort(
    (a, b) =>
      b.reads + b.injected - (a.reads + a.injected) ||
      a.doc.localeCompare(b.doc) ||
      a.id.localeCompare(b.id),
  );
}
