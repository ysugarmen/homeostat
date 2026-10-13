import { resolve } from "node:path";
import { type AgentName, dueAgents, readKbFiles, validate } from "@homeostat/core";
import type { Io } from "./cli.ts";
import { runCurate } from "./curate.ts";
import { runDeepDive } from "./deep-dive.ts";
import { git } from "./git.ts";

export interface UpOptions {
  dir: string;
  /** Check the schedule once and exit; for tests and for an external cron. */
  once?: boolean;
  /** Run every enabled agent now, ignoring the schedule, then exit. */
  runNow?: boolean;
}

const RUNNERS: Record<AgentName, (dir: string, io: Io) => Promise<number>> = {
  curator: (dir, io) => runCurate({ dir }, io),
  deepDive: (dir, io) => runDeepDive({ dir }, io),
};

/** One scheduler tick: refresh the KB checkout, then run whatever is due. Returns the worst exit code. */
async function tick(root: string, io: Io, now: Date, all: boolean): Promise<number> {
  if (git(root, "remote", "get-url", "origin") !== undefined) {
    if (git(root, "pull", "--ff-only", "--quiet") === undefined) {
      io.stderr("homeostat up: git pull failed; running on the current checkout\n");
    }
  }
  const config = validate(readKbFiles(root)).config;
  if (!config) {
    io.stderr("homeostat up: homeostat.yaml is missing or invalid; nothing run\n");
    return 1;
  }
  const due = all
    ? (["curator", "deepDive"] as const).filter((a) => config.agents[a].enabled)
    : dueAgents(config, now);
  let code = 0;
  for (const agent of due) {
    io.stdout(`[${now.toISOString()}] running ${agent}\n`);
    code = Math.max(code, await RUNNERS[agent](root, io));
  }
  return code;
}

/**
 * `homeostat up`: the central scheduler for a shared box, the alternative to the CI schedule. Checks the
 * agents' cron schedules (UTC) every minute. The dashboard joins it in Phase 4.
 */
export async function runUp(opts: UpOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir);
  const now = () => io.now?.() ?? new Date();
  if (opts.runNow) return tick(root, io, now(), true);
  if (opts.once) {
    const code = await tick(root, io, now(), false);
    return code;
  }

  io.stdout(`homeostat up: scheduling agents for ${root} (UTC); Ctrl-C to stop\n`);
  let last = "";
  let running = false;
  await new Promise<void>((done) => {
    const timer = setInterval(async () => {
      const minute = now().toISOString().slice(0, 16);
      if (minute === last || running) return;
      last = minute;
      running = true;
      try {
        await tick(root, io, now(), false);
      } catch (e) {
        io.stderr(`homeostat up: ${(e as Error).message}\n`);
      } finally {
        running = false;
      }
    }, 15_000);
    process.once("SIGINT", () => {
      clearInterval(timer);
      done();
    });
  });
  return 0;
}
