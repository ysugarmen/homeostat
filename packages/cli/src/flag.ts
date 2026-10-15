import { resolve } from "node:path";
import {
  flagEntry,
  logEvent,
  readKbView,
  scanSecrets,
  validate,
  writePendingFile,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { commitFile, git, pushBranch } from "./git.ts";
import { memberIdFrom } from "./init.ts";
import { sendPending } from "./learn.ts";
import { CliError } from "./provider.ts";

export interface FlagOptions {
  dir: string;
  reason?: string;
  by?: string;
  branch?: string;
  push?: boolean;
}

/** `homeostat flag <id>`: reports that an entry is wrong. It loses score and goes back to review. */
export function runFlag(id: string, opts: FlagOptions, io: Io): number {
  try {
    const root = resolve(opts.dir);
    if (!opts.reason?.trim()) throw new CliError("--reason is required: say what is wrong");
    const leak = scanSecrets(opts.reason)[0];
    if (leak)
      throw new CliError(`the reason contains a possible ${leak.kind}; remove it before flagging`);
    if (opts.push && !opts.branch) throw new CliError("--push needs --branch");
    const kb = validate(readKbView(root).files);
    if (!kb.config) {
      throw new CliError("homeostat.yaml is missing or invalid; run homeostat validate");
    }
    const found = kb.entries.find((e) => e.entry.frontmatter.id === id);
    if (!found) throw new CliError(`no entry with id "${id}"`);

    const by = opts.by ?? memberIdFrom(git(root, "config", "user.name"));
    if (!kb.config.team.members.some((m) => m.id === by)) {
      throw new CliError(`"${by}" is not a team member; pass --by <member-id>`);
    }
    const date = (io.now?.() ?? new Date()).toISOString().slice(0, 10);
    const text = flagEntry(found.entry, { by, reason: opts.reason.trim(), date }, kb.config);
    const status = text.match(/^status: (\w+)$/m)?.[1];
    logEvent(root, {
      ts: (io.now?.() ?? new Date()).toISOString(),
      type: "entry-flagged",
      id,
      by,
      reason: opts.reason.trim(),
    });

    if (opts.branch) {
      try {
        commitFile(root, opts.branch, found.path, text, `homeostat: flag ${id}`);
        if (opts.push) pushBranch(root, opts.branch);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      io.stdout(
        `flagged ${id} on ${opts.branch}${opts.push ? " (pushed)" : ""}; it is ${status} until a reviewer decides\n`,
      );
      return 0;
    }
    writePendingFile(root, found.path, text);
    sendPending(root, io);
    io.stdout(
      `flagged ${id}: it is ${status} in your sessions now, and tomorrow's daily run takes the flag to the team\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
