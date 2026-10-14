import { type Asker, apiAsker, type Config, claudeCodeAsker, logEvent } from "@homeostat/core";
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
): Asker {
  const { model, effort } = config.agents[agent];
  const runtime = config.agents.runtime;
  const ask =
    runtime === "api"
      ? apiAsker({ model, effort, env: { ...io.env } })
      : claudeCodeAsker({ model, effort, env: { ...io.env } });
  return async (system, user, schema) => {
    const record = (ok: boolean) =>
      logEvent(kbRoot, {
        type: "model-call",
        agent,
        runtime,
        model,
        chars: system.length + user.length,
        ok,
      });
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
