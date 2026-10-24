import type { Event } from "../events.ts";
import { isRejectedDecision } from "../schema.ts";
import type { MetricsSnapshot } from "./types.ts";
import { inWindow, ratio, windows } from "./util.ts";

/**
 * Whether agents use the knowledge, from the Stop hook's `turn-usage` events: the share of turns
 * that called a Homeostat tool that hands knowledge back, the share whose reply credited it with
 * `> From Homeostat (…)`, and which rules were served to sessions but never credited.
 */
export interface TurnMetrics {
  /** User turns recorded in the window. */
  turns: number;
  /** Turns that called context, search, explain, docs or read, over turns. */
  retrievedShare?: number;
  /** Turns whose reply carried a credit line, over turns. */
  creditedShare?: number;
  /** Of the turns that retrieved, the share that credited: whether what came back was used. */
  creditedAfterRetrieval?: number;
  /** Distinct rule ids, and document sections or documents, credited in the window. */
  distinctRules: number;
  distinctDocs: number;
  /**
   * Accepted rules a session here was given in the window but no reply credited, best first by
   * score. Empty until turns are recorded, since without them nothing could have been credited.
   */
  neverCredited: string[];
  previous: { turns: number; retrievedShare?: number; creditedShare?: number };
}

interface Turn {
  retrieved: boolean;
  credited: boolean;
  credits: string[];
}

/** The last event per session and turn: a turn re-read after its reply was flushed counts once. */
function turnsIn(events: readonly Event[]): Turn[] {
  const latest = new Map<string, Turn>();
  for (const e of events) {
    if (e.type !== "turn-usage") continue;
    latest.set(`${String(e.session)}\n${String(e.turn)}`, {
      retrieved: e.retrieved === true,
      credited: e.credited === true,
      credits: Array.isArray(e.credits) ? e.credits.filter((c) => typeof c === "string") : [],
    });
  }
  return [...latest.values()];
}

export function turnMetrics(snap: MetricsSnapshot): TurnMetrics {
  const w = windows(snap.now, snap.window.days);
  const current = turnsIn(snap.events.filter((e) => inWindow(e.ts, w.current)));
  const before = turnsIn(snap.events.filter((e) => inWindow(e.ts, w.previous)));
  const shares = (list: Turn[]) => {
    const retrieved = ratio(list.filter((t) => t.retrieved).length, list.length);
    const credited = ratio(list.filter((t) => t.credited).length, list.length);
    return {
      ...(retrieved === undefined ? {} : { retrievedShare: retrieved }),
      ...(credited === undefined ? {} : { creditedShare: credited }),
    };
  };
  const credits = new Set(current.flatMap((t) => t.credits));
  const retrievers = current.filter((t) => t.retrieved);
  const afterRetrieval = ratio(retrievers.filter((t) => t.credited).length, retrievers.length);

  const served = new Set(
    snap.events
      .filter((e) => e.type === "injection" && inWindow(e.ts, w.current))
      .flatMap((e) => ((e.entries as { id?: unknown }[] | undefined) ?? []).map((x) => x.id)),
  );
  const neverCredited = current.length
    ? snap.entries
        .filter(
          (e) =>
            e.frontmatter.status === "accepted" &&
            !isRejectedDecision(e.frontmatter) &&
            served.has(e.frontmatter.id) &&
            !credits.has(e.frontmatter.id.toLowerCase()),
        )
        .sort(
          (a, b) =>
            b.frontmatter.score - a.frontmatter.score ||
            a.frontmatter.id.localeCompare(b.frontmatter.id),
        )
        .map((e) => e.frontmatter.id)
    : [];

  return {
    turns: current.length,
    ...shares(current),
    ...(afterRetrieval === undefined ? {} : { creditedAfterRetrieval: afterRetrieval }),
    distinctRules: [...credits].filter((c) => !c.includes("/")).length,
    distinctDocs: [...credits].filter((c) => c.includes("/")).length,
    neverCredited,
    previous: { turns: before.length, ...shares(before) },
  };
}
