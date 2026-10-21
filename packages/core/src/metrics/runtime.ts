import type { Event } from "../events.ts";
import type { MetricsSnapshot, Percentiles } from "./types.ts";
import { inWindow, median, percentiles, ratio, windows } from "./util.ts";

export interface Runtime {
  /** Hook wall time at session start, from the starts that recorded it. */
  sessionStart?: Percentiles & { previous?: Percentiles; failures: number };
  /** What a session start injects, from the starts that recorded a token count. */
  context?: { injections: number; tokensMedian: number; charsMedian?: number; fullShare?: number };
  mcp: { tool: string; calls: number; failures: number; latency?: Percentiles }[];
  dailyRuns: {
    at: string;
    durationMs?: number;
    modelCalls?: number;
    chars?: number;
    failedCalls?: number;
    lessons: number;
    callsPerLesson?: number;
  }[];
  lastRun?: { at: string; durationMs?: number; previousMedianMs?: number };
  sync?: { runs: number; failures: number; latency?: Percentiles };
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function runtime(snap: MetricsSnapshot): Runtime {
  const w = windows(snap.now, snap.window.days);
  const starts = snap.events.filter((e) => e.type === "injection" && e.source === "startup");
  const current = starts.filter((e) => inWindow(e.ts, w.current));
  const timed = (list: Event[]) => list.flatMap((e) => num(e.ms) ?? []);
  const sessionStart = percentiles(timed(current));
  const previous = percentiles(timed(starts.filter((e) => inWindow(e.ts, w.previous))));

  const withTokens = current.filter((e) => num(e.tokens) !== undefined);
  const forms = withTokens.flatMap((e) =>
    ((e.entries as { form: string }[] | undefined) ?? []).map((x) => x.form),
  );
  const charsMedian = median(withTokens.flatMap((e) => num(e.chars) ?? []));
  const fullShare = ratio(forms.filter((f) => f === "full").length, forms.length);

  const calls = snap.events.filter((e) => e.type === "mcp-call" && inWindow(e.ts, w.current));
  const tools = new Map<string, Event[]>();
  for (const e of calls) tools.set(String(e.tool), [...(tools.get(String(e.tool)) ?? []), e]);
  const mcp = [...tools.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, list]) => {
      const latency = percentiles(timed(list));
      return {
        tool,
        calls: list.length,
        failures: list.filter((e) => e.ok === false).length,
        ...(latency ? { latency } : {}),
      };
    });

  const runs = snap.runs.slice(-snap.window.runs);
  const duration = (r: (typeof runs)[number]) =>
    r.timing ? Date.parse(r.timing.finished) - Date.parse(r.timing.started) : undefined;
  const dailyRuns = runs.map((r) => {
    const d = duration(r);
    const perLesson = r.timing ? ratio(r.timing.modelCalls, r.lessons.length) : undefined;
    return {
      at: r.at,
      ...(d === undefined ? {} : { durationMs: d }),
      ...(r.timing
        ? {
            modelCalls: r.timing.modelCalls,
            chars: r.timing.chars,
            failedCalls: r.timing.failedCalls,
          }
        : {}),
      lessons: r.lessons.length,
      ...(perLesson === undefined ? {} : { callsPerLesson: perLesson }),
    };
  });
  const last = snap.runs.at(-1);
  const others = snap.runs.slice(0, -1).flatMap((r) => duration(r) ?? []);
  const lastDuration = last ? duration(last) : undefined;
  const previousMedian = median(others);

  const syncs = snap.events.filter((e) => e.type === "sync-run" && inWindow(e.ts, w.current));
  const syncLatency = percentiles(timed(syncs));

  return {
    ...(sessionStart
      ? {
          sessionStart: {
            ...sessionStart,
            failures: current.filter((e) => e.ok === false).length,
            ...(previous ? { previous } : {}),
          },
        }
      : {}),
    ...(withTokens.length
      ? {
          context: {
            injections: withTokens.length,
            tokensMedian: median(withTokens.map((e) => num(e.tokens) ?? 0)) ?? 0,
            ...(charsMedian === undefined ? {} : { charsMedian }),
            ...(fullShare === undefined ? {} : { fullShare }),
          },
        }
      : {}),
    mcp,
    dailyRuns,
    ...(last
      ? {
          lastRun: {
            at: last.at,
            ...(lastDuration === undefined ? {} : { durationMs: lastDuration }),
            ...(previousMedian === undefined ? {} : { previousMedianMs: previousMedian }),
          },
        }
      : {}),
    ...(syncs.length
      ? {
          sync: {
            runs: syncs.length,
            failures: syncs.filter((e) => e.ok === false).length,
            ...(syncLatency ? { latency: syncLatency } : {}),
          },
        }
      : {}),
  };
}
