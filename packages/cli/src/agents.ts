import {
  type Asker,
  apiAsker,
  bedrockAsker,
  type Config,
  claudeCodeAsker,
  judgeModelFor,
  logEvent,
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
  /** Summed from the runtime's own estimates; absent when the runtime gives none (the API). */
  costUsd?: number;
}

/** A run's model use: totals for timing, and per agent (curator, judge, deepDive). */
export interface RunStats {
  calls: number;
  chars: number;
  failed: number;
  byAgent?: Record<string, AgentUse>;
}

export const newRunStats = (): RunStats => ({ calls: 0, chars: 0, failed: 0, byAgent: {} });

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
  const total = costs.length
    ? `, about $${costs.reduce((a, b) => a + b, 0).toFixed(2)} at API prices`
    : "";
  return `model use: ${stats.calls} calls${total}\n${lines.join("\n")}\n`;
}

/**
 * The Claude runtime configured for `agent` in homeostat.yaml. Each call is logged as a
 * `model-call` event with its size, runtime and model, never its content (security plan T5).
 * `judge` is the daily run's draft judge: the curator's runtime with its own model and effort
 * (`agents.curator.judgeModel`, a different model from the drafter's by default), so it is not
 * the model grading its own output. On `claude-code` the model is passed through `--model`.
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
    if (u.costUsd !== undefined) a.costUsd = (a.costUsd ?? 0) + u.costUsd;
  };
  const ask = {
    api: () => apiAsker({ model, effort, env: { ...io.env }, onUsage }),
    "claude-code": () => claudeCodeAsker({ model, effort, env: { ...io.env }, onUsage }),
    bedrock: () => bedrockAsker({ model, effort, ...config.agents.bedrock, onUsage }),
    vertex: () => vertexAsker({ model, effort, ...config.agents.vertex, onUsage }),
  }[runtime]();
  return async (system, user, schema) => {
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
