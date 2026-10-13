import { resolve } from "node:path";
import {
  ClaudeConflictJudge,
  ClaudeMerger,
  ClaudeUnavailableError,
  type DeepDiveChange,
  DeepDiveError,
  deepDive,
  validate,
} from "@kbx/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { readKbFiles } from "./files.ts";
import { plural } from "./format.ts";
import { CliError, providerFor } from "./provider.ts";
import { publish } from "./publish.ts";

export interface DeepDiveOptions {
  dir: string;
  dryRun?: boolean;
  /** Commander turns `--no-llm` into `llm: false`. */
  llm?: boolean;
}

function prBody(changes: DeepDiveChange[], notes: string[]): string {
  const rows = changes.flatMap((c) =>
    c.actions.map((a) => `| ${c.id} | ${a.action} | ${a.note} |`),
  );
  return [
    "The weekly kbx deep dive: near-duplicates merged, contradictions marked disputed, stale entries retired.",
    "",
    "| Entry | Action | Detail |",
    "| --- | --- | --- |",
    ...rows,
    ...(notes.length ? ["", "Needs a human:", "", ...notes.map((n) => `- ${n}`)] : []),
    "",
    "Edit or revert any change on this branch before merging.",
  ].join("\n");
}

/** `kbx deep-dive`: the weekly maintenance run, meant for the KB repo's scheduled CI job. */
export async function runDeepDive(opts: DeepDiveOptions, io: Io): Promise<number> {
  try {
    const root = resolve(opts.dir);
    const files = readKbFiles(root);
    const config = validate(files).config;
    if (!config) throw new CliError("kbx.yaml is missing or invalid; run kbx validate");

    const now = io.now?.() ?? new Date();
    const today = now.toISOString().slice(0, 10);
    const ask = askerFor(config, "deepDive", io);
    const useLlm = opts.llm !== false;
    const merger = useLlm ? (io.merger ?? new ClaudeMerger(ask)) : undefined;
    const judge = useLlm ? (io.judge ?? new ClaudeConflictJudge(ask)) : undefined;

    const { changes, notes } = await deepDive({
      files,
      today,
      ...(merger ? { merger } : {}),
      ...(judge ? { judge } : {}),
    });
    for (const c of changes) {
      for (const a of c.actions) io.stdout(`${c.path}: ${a.action} (${a.note})\n`);
    }
    for (const n of notes) io.stdout(`note: ${n}\n`);
    if (changes.length === 0) {
      io.stdout("nothing to change\n");
      return 0;
    }
    if (opts.dryRun) {
      io.stdout("dry run: nothing committed\n");
      return 0;
    }

    const sources = config.sources;
    if (!sources) {
      throw new CliError("kbx.yaml has no sources section; it is needed to open the PR");
    }
    const [owner = "", name = ""] = sources.kbRepo.split("/");
    await publish({
      root,
      branch: `kbx/deep-dive-${today}`,
      changes: changes.map((c) => ({
        path: c.path,
        text: c.text,
        message: `kbx: ${c.actions.map((a) => a.action).join(", ")} ${c.id}`,
      })),
      provider: providerFor(sources.host, io, "open the deep-dive PR"),
      kbRepo: { owner, name },
      base: sources.baseBranch,
      title: `kbx: weekly deep dive (${plural(changes.length, "entry", "entries")} changed)`,
      body: prBody(changes, notes),
      io,
    });
    return 0;
  } catch (e) {
    if (
      e instanceof CliError ||
      e instanceof DeepDiveError ||
      e instanceof ClaudeUnavailableError
    ) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
