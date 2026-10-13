import { resolve } from "node:path";
import type { Io } from "./cli.ts";

export interface EventsOptions {
  dir?: string;
  since?: string;
  type?: string[];
  json?: boolean;
}

import { formatEvent, readEvents } from "@homeostat/core";
import { findKb } from "./hook.ts";

/** `homeostat events`: the KB's local event log, one readable line per event. */
export function runEvents(opts: EventsOptions, io: Io): number {
  const root = opts.dir ? resolve(opts.dir) : findKb(io.env, process.cwd());
  if (!root) {
    io.stderr("no knowledge base here: pass --dir, set HOMEOSTAT_DIR, or run inside the KB repo\n");
    return 1;
  }
  const since =
    opts.since ?? new Date((io.now?.() ?? new Date()).getTime() - 86_400_000).toISOString();
  const events = readEvents(root, { since, ...(opts.type?.length ? { types: opts.type } : {}) });
  if (opts.json) io.stdout(`${JSON.stringify(events, null, 2)}\n`);
  else
    io.stdout(
      events.length ? `${events.map(formatEvent).join("\n")}\n` : `no events since ${since}\n`,
    );
  return 0;
}
