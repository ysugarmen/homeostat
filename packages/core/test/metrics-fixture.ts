import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord, RunReport } from "../src/automation.ts";
import type { Event } from "../src/events.ts";
import { DEFAULT_WINDOW, type MetricsSnapshot } from "../src/metrics/types.ts";
import { validate } from "../src/validate.ts";

const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;

export const NOW = new Date("2026-10-21T12:00:00Z");

/** A metrics snapshot over the starter KB, with nothing recorded unless `over` says so. */
export function snapshot(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  const files: Record<string, string> = {};
  for (const f of readdirSync(starter, { recursive: true, encoding: "utf8" })) {
    if ((f.endsWith(".md") || f.endsWith(".yaml")) && f !== "README.md")
      files[f] = readFileSync(join(starter, f), "utf8");
  }
  const kb = validate(files);
  if (!kb.config) throw new Error("the starter KB's config is invalid");
  return {
    config: kb.config,
    entries: kb.entries.map((e) => ({ ...e.entry, path: e.path })),
    events: [],
    runs: [],
    decisions: [],
    heartbeats: [],
    now: NOW,
    window: DEFAULT_WINDOW,
    ...over,
  };
}

export const ev = (ts: string, type: string, rest: Record<string, unknown> = {}): Event => ({
  ts,
  type,
  ...rest,
});

type Lesson = RunReport["lessons"][number];

/** A run report whose member rows are summed from its lessons. */
export function run(at: string, lessons: Partial<Lesson>[]): RunReport {
  const full: Lesson[] = lessons.map((l, i) => ({
    member: "lee",
    id: `lesson-${i}`,
    decision: "merged",
    reason: "",
    ...l,
  }));
  const members = new Map<string, RunReport["members"][number]>();
  for (const l of full) {
    const row = members.get(l.member) ?? { member: l.member, merged: 0, declined: 0, review: 0 };
    row[l.decision]++;
    members.set(l.member, row);
  }
  return { at, members: [...members.values()], settled: 0, lessons: full };
}

export function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    path: "knowledge/core/x.md",
    id: "x",
    hash: "h",
    decision: "merged",
    reason: "",
    at: "2026-10-20T06:00:00Z",
    ...over,
  };
}
