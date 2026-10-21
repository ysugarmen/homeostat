import type { RunReport } from "../automation.ts";
import type { MetricsSnapshot } from "./types.ts";
import { ratio } from "./util.ts";

export interface DecisionTotals {
  merged: number;
  review: number;
  declined: number;
  /** Declined because an accepted rule already said it; counted within `declined` too. */
  duplicates: number;
  total: number;
  /** Merged by the run itself, over the decisions that were not duplicates. */
  autoMergeShare?: number;
}

export interface DecisionsMetrics {
  /** The last `window.runs` reports. */
  current: DecisionTotals;
  /** The reports before them, when the KB has any. */
  previous?: DecisionTotals;
  perRun: ({ at: string } & DecisionTotals)[];
  byMember: ({ member: string } & DecisionTotals)[];
  bySource: ({ source: string } & DecisionTotals)[];
}

type Lesson = RunReport["lessons"][number];

/** Runs before 0.2.2 mark a duplicate only in the reason text. */
export const isDuplicate = (l: Lesson) =>
  l.duplicateOf !== undefined || /^duplicate of /.test(l.reason);

function totals(lessons: readonly Lesson[]): DecisionTotals {
  const t = { merged: 0, review: 0, declined: 0, duplicates: 0, total: lessons.length };
  for (const l of lessons) {
    t[l.decision]++;
    if (isDuplicate(l)) t.duplicates++;
  }
  const share = ratio(t.merged, t.total - t.duplicates);
  return { ...t, ...(share === undefined ? {} : { autoMergeShare: share }) };
}

function grouped<K extends string>(
  lessons: readonly Lesson[],
  key: K,
  of: (l: Lesson) => string,
): ({ [P in K]: string } & DecisionTotals)[] {
  const groups = new Map<string, Lesson[]>();
  for (const l of lessons) groups.set(of(l), [...(groups.get(of(l)) ?? []), l]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, list]) => ({ [key]: name, ...totals(list) }) as { [P in K]: string } & DecisionTotals,
    );
}

export function decisionsMetrics(snap: MetricsSnapshot): DecisionsMetrics {
  const current = snap.runs.slice(-snap.window.runs);
  const previous = snap.runs.slice(0, Math.max(0, snap.runs.length - snap.window.runs));
  const lessons = current.flatMap((r) => r.lessons);
  return {
    current: totals(lessons),
    ...(previous.length ? { previous: totals(previous.flatMap((r) => r.lessons)) } : {}),
    perRun: current.map((r) => ({ at: r.at, ...totals(r.lessons) })),
    byMember: grouped(lessons, "member", (l) => l.member),
    bySource: grouped(lessons, "source", (l) => l.source ?? "unknown"),
  };
}
