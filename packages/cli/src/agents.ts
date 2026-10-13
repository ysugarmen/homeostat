import { type Asker, apiAsker, type Config, claudeCodeAsker } from "@homeostat/core";
import type { Io } from "./cli.ts";

/** The Claude runtime configured for `agent` in homeostat.yaml. */
export function askerFor(config: Config, agent: "curator" | "deepDive", io: Io): Asker {
  const { model, effort } = config.agents[agent];
  return config.agents.runtime === "api"
    ? apiAsker({ model, effort, env: { ...io.env } })
    : claudeCodeAsker({ model, effort, env: { ...io.env } });
}
