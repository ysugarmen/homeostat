import {
  type Asker,
  apiAsker,
  bedrockAsker,
  type Config,
  claudeCodeAsker,
  logEvent,
  vertexAsker,
} from "@homeostat/core";
import type { Io } from "./cli.ts";

/**
 * The Claude runtime configured for `agent` in homeostat.yaml. Each call is logged as a
 * `model-call` event with its size, runtime and model, never its content (security plan T5).
 */
export function askerFor(
  config: Config,
  agent: "curator" | "deepDive",
  io: Io,
  kbRoot: string,
  /** Counts every call, its size and failures across the run, for the run report's timing. */
  stats?: { calls: number; chars: number; failed: number },
): Asker {
  const { model, effort } = config.agents[agent];
  const runtime = config.agents.runtime;
  const ask = {
    api: () => apiAsker({ model, effort, env: { ...io.env } }),
    "claude-code": () => claudeCodeAsker({ model, effort, env: { ...io.env } }),
    bedrock: () => bedrockAsker({ model, effort, ...config.agents.bedrock }),
    vertex: () => vertexAsker({ model, effort, ...config.agents.vertex }),
  }[runtime]();
  return async (system, user, schema) => {
    const record = (ok: boolean) => {
      const chars = system.length + user.length;
      if (stats) {
        stats.calls++;
        stats.chars += chars;
        if (!ok) stats.failed++;
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
