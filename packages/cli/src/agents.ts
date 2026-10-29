import {
  type Asker,
  apiAsker,
  bedrockAsker,
  type Config,
  claudeCodeAsker,
  estimateCostUsd,
  judgeModelFor,
  logEvent,
  SpendingCapError,
  type Usage,
  vertexAsker,
} from "@homeostat/core";
import type { Io } from "./cli.ts";

/** One agent's model use over a run. */
export interface AgentUse {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Summed from the runtime's own estimates (Claude Code), or priced from the tokens where the
   * runtime gives none (the API, Bedrock, Vertex): then `estimated` is set.
   */
  costUsd?: number;
  estimated?: boolean;
}

/** A run's model use: totals for timing, and per agent (curator, judge, deepDive). */
export interface RunStats {
  calls: number;
  chars: number;
  failed: number;
  byAgent?: Record<string, AgentUse>;
  /** `agents.maxCostUsd`, or `--max-cost`: no call starts once the run has spent this. */
  maxCostUsd?: number;
  /** Set when a call was refused at the cap. */
  capped?: boolean;
}

export const newRunStats = (maxCostUsd?: number): RunStats => ({
  calls: 0,
  chars: 0,
  failed: 0,
  byAgent: {},
  ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
});

/** What the run has spent so far, and whether any of it was priced from tokens. */
export function runCost(stats: RunStats): { usd: number; estimated: boolean } {
  const used = Object.values(stats.byAgent ?? {});
  return {
    usd: used.reduce((n, u) => n + (u.costUsd ?? 0), 0),
    estimated: used.some((u) => u.estimated),
  };
}

/** The cap line for the output and the run report: "stopped at the spending cap: $X of $Y". */
export function capLine(stats: RunStats, left: number, what = "lesson"): string {
  const { usd, estimated } = runCost(stats);
  return `stopped at the spending cap: $${usd.toFixed(2)} of $${(stats.maxCostUsd ?? 0).toFixed(2)}${estimated ? " (estimated from tokens)" : ""}; ${left} ${what}${left === 1 ? "" : "s"} left for the next run`;
}

/** One line per agent: calls, tokens and cost, for the end of a run's output. */
export function formatRunUse(stats: RunStats): string {
  const k = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
  const rows = Object.entries(stats.byAgent ?? {}).filter(([, u]) => u.calls > 0);
  if (rows.length === 0) return "";
  const lines = rows.map(
    ([agent, u]) =>
      `  ${agent} (${u.model}): ${u.calls} calls, ${k(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} in, ${k(u.outputTokens)} out${u.costUsd !== undefined ? `, $${u.costUsd.toFixed(2)}` : ""}`,
  );
  const costs = rows.map(([, u]) => u.costUsd).filter((c) => c !== undefined);
  const estimated = rows.some(([, u]) => u.estimated) ? ", estimated from tokens" : "";
  const total = costs.length
    ? `, about $${costs.reduce((a, b) => a + b, 0).toFixed(2)} at API prices${estimated}`
    : "";
  return `model use: ${stats.calls} calls${total}\n${lines.join("\n")}\n`;
}

/**
 * The Claude runtime configured for `agent` in homeostat.yaml. Each call is logged as a
 * `model-call` event with its size, runtime and model, never its content (security plan T5).
 * `judge` is the daily run's draft judge: the curator's runtime with its own model and effort
 * (`agents.curator.judgeModel`, a different model from the drafter's by default), so it is not
 * the model grading its own output. On `claude-code` the model is passed through `--model`.
 *
 * With a cap in `stats.maxCostUsd`, a call that would start once the run has spent the cap throws
 * `SpendingCapError` instead, and sets `stats.capped`; callers stop asking and leave the rest.
 */
export function askerFor(
  config: Config,
  agent: "curator" | "deepDive" | "judge",
  io: Io,
  kbRoot: string,
  /** Counts every call, its size, failures and usage across the run, for the run report. */
  stats?: RunStats,
): Asker {
  const { model, effort } =
    agent === "judge"
      ? { model: judgeModelFor(config), effort: config.agents.curator.judgeEffort }
      : config.agents[agent];
  const runtime = config.agents.runtime;
  const onUsage = (u: Usage) => {
    if (!stats) return;
    stats.byAgent ??= {};
    const a = (stats.byAgent[agent] ??= {
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    a.inputTokens += u.inputTokens;
    a.outputTokens += u.outputTokens;
    a.cacheReadTokens += u.cacheReadTokens;
    a.cacheWriteTokens += u.cacheWriteTokens;
    // The API runtimes report tokens only: priced from the table in core, and marked so.
    if (u.costUsd === undefined) a.estimated = true;
    a.costUsd = (a.costUsd ?? 0) + (u.costUsd ?? estimateCostUsd(model, u));
  };
  const ask = io.runtime
    ? io.runtime({ agent, model, onUsage })
    : {
        api: () => apiAsker({ model, effort, env: { ...io.env }, onUsage }),
        "claude-code": () => claudeCodeAsker({ model, effort, env: { ...io.env }, onUsage }),
        bedrock: () => bedrockAsker({ model, effort, ...config.agents.bedrock, onUsage }),
        vertex: () => vertexAsker({ model, effort, ...config.agents.vertex, onUsage }),
      }[runtime]();
  return async (system, user, schema) => {
    if (stats?.maxCostUsd !== undefined) {
      const spent = runCost(stats).usd;
      if (spent >= stats.maxCostUsd) {
        stats.capped = true;
        throw new SpendingCapError(spent, stats.maxCostUsd);
      }
    }
    const record = (ok: boolean) => {
      const chars = system.length + user.length;
      if (stats) {
        stats.calls++;
        stats.chars += chars;
        if (!ok) stats.failed++;
        stats.byAgent ??= {};
        const a = (stats.byAgent[agent] ??= {
          model,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        a.calls++;
      }
      logEvent(kbRoot, { type: "model-call", agent, runtime, model, chars, ok });
    };
    try {
      const out = await ask(system, user, schema);
      record(true);
      return out;
    } catch (e) {
      record(false);
      throw e;
    }
  };
}
