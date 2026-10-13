import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  EXPORT_TARGETS,
  type ExportTarget,
  exportRules,
  removeBlock,
  replaceBlock,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { readKbFiles } from "./files.ts";
import { CliError } from "./provider.ts";

export interface ExportOptions {
  kb?: string;
  out: string;
  target?: string[];
  check?: boolean;
}

/** Relative paths of every file under `dir`, `/`-separated; empty when it does not exist. */
function listFiles(root: string, dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) =>
      join(d.parentPath, d.name)
        .slice(root.length + 1)
        .split(sep)
        .join("/"),
    );
}

const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** `homeostat export`: writes accepted entries into a code repo as each agent's native rules files. */
export function runExport(opts: ExportOptions, io: Io): number {
  try {
    const kbRoot = resolve(opts.kb ?? io.env?.HOMEOSTAT_DIR ?? ".");
    const out = resolve(opts.out);
    const { config, entries } = validate(readKbFiles(kbRoot));
    if (!config) {
      throw new CliError(
        `homeostat.yaml is missing or invalid in ${kbRoot}; run homeostat validate`,
      );
    }

    for (const t of opts.target ?? []) {
      if (!(EXPORT_TARGETS as readonly string[]).includes(t)) {
        throw new CliError(`unknown target "${t}"; use claude, cursor, agents-md or copilot`);
      }
    }
    const targets = (
      opts.target?.length ? opts.target : config.distribution.exports
    ) as ExportTarget[];
    const plan = exportRules(
      entries.map((e) => e.entry),
      targets,
    );

    // Desired content per path; undefined means the file should not exist.
    const desired = new Map<string, string | undefined>();
    for (const dir of plan.ownedDirs) {
      for (const path of listFiles(out, dir)) desired.set(path, undefined);
    }
    for (const [path, text] of Object.entries(plan.owned)) desired.set(path, text);
    for (const [path, block] of Object.entries(plan.blocks)) {
      const existing = readOr(join(out, path));
      if (block) {
        desired.set(path, replaceBlock(existing, block));
      } else if (existing !== undefined) {
        const rest = removeBlock(existing);
        desired.set(path, rest || undefined);
      }
    }

    const changed = [...desired].filter(([path, text]) => readOr(join(out, path)) !== text);
    if (changed.length === 0) {
      io.stdout("exported rules are up to date\n");
      return 0;
    }
    if (opts.check) {
      for (const [path] of changed) io.stdout(`out of date: ${path}\n`);
      io.stdout("run homeostat export to update\n");
      return 1;
    }
    for (const [path, text] of changed) {
      const full = join(out, ...path.split("/"));
      if (text === undefined) {
        rmSync(full, { force: true });
        io.stdout(`removed ${path}\n`);
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
        io.stdout(`wrote ${path}\n`);
      }
    }
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
