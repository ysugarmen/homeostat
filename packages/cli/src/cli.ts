import { createInterface } from "node:readline/promises";
import type { ConflictJudge, Drafter, Merger, Provider } from "@homeostat/core";
import { Command, CommanderError } from "commander";
import { runCodeowners } from "./codeowners.ts";
import { type CurateOptions, runCurate } from "./curate.ts";
import { type DeepDiveOptions, runDeepDive } from "./deep-dive.ts";
import { runEvents } from "./events-command.ts";
import { type ExportOptions, runExport } from "./export.ts";
import { type FlagOptions, runFlag } from "./flag.ts";
import { HOOK_EVENTS, runHook } from "./hook.ts";
import { HOSTS, type InitOptions, runInit } from "./init.ts";
import { type LearnOptions, runLearn } from "./learn.ts";
import { runMcp } from "./mcp.ts";
import { runExplain, runList, runSearch, runStatus } from "./query.ts";
import { runUp, type UpOptions } from "./up.ts";
import { runValidate } from "./validate.ts";

/** Everything the commands touch outside the file system, so tests can supply their own. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** Prompts for one line; absent when there is no terminal to ask. */
  ask?: (question: string) => Promise<string>;
  /** Environment variables, for tokens. Defaults to none, so tests never see real tokens. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Reads all of stdin; hooks receive their event JSON this way. */
  stdin?: () => Promise<string>;
  /** Test seams for the agents: a git-host provider and a drafter instead of the real ones. */
  provider?: Provider;
  drafter?: Drafter;
  merger?: Merger;
  judge?: ConflictJudge;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function askTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`${question}: `);
  } finally {
    rl.close();
  }
}

export const processIo: Io = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  ...(process.stdin.isTTY ? { ask: askTerminal } : {}),
  env: process.env,
  stdin: readStdin,
};

/** Runs the CLI with `argv` (as in `process.argv`) and returns the exit code. */
export async function runCli(argv: readonly string[], io: Io = processIo): Promise<number> {
  let exitCode = 0;
  const program = new Command("homeostat")
    .description("Team knowledge base for coding agents.")
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  program
    .command("validate")
    .aliases(["check", "lint"])
    .description("Check homeostat.yaml and every entry under knowledge/.")
    .argument("[dir]", "knowledge base root", ".")
    .option("--fix", "rewrite stale score and tokens values")
    .option("--json", "print the result as JSON")
    .action((dir: string, opts: { fix?: boolean; json?: boolean }) => {
      exitCode = runValidate(dir, opts, io);
    });

  program
    .command("codeowners")
    .description("Generate CODEOWNERS from homeostat.yaml and entry owners.")
    .argument("[dir]", "knowledge base root", ".")
    .option("--check", "exit 1 if CODEOWNERS is stale, without writing it")
    .action((dir: string, opts: { check?: boolean }) => {
      exitCode = runCodeowners(dir, opts, io);
    });

  program
    .command("init")
    .description("Scaffold homeostat.yaml, knowledge/ and a validate CI file in a KB repo.")
    .argument("[dir]", "knowledge base root", ".")
    .option("--host <host>", `git host for the CI file: ${HOSTS.join(" or ")} (default: detect)`)
    .option("--member <id>", "id of the first (senior) member (default: from git user.name)")
    .option("--handle <handle>", "CODEOWNERS handle of the first member, e.g. @you")
    .option("--force", "overwrite an existing homeostat.yaml")
    .action((dir: string, opts: InitOptions) => {
      exitCode = runInit(dir, opts, io);
    });

  const collect = (value: string, previous: string[] = []) => [...previous, value];
  program
    .command("learn")
    .aliases(["add", "remember"])
    .description("Write a candidate entry from flags, prompts, or a PR review comment URL.")
    .argument("[url]", "Bitbucket or GitHub PR review comment link")
    .option("--dir <dir>", "knowledge base root", ".")
    .option("--title <text>", "imperative one-line title")
    .option("--rule <text>", "the rule, one paragraph of at most 60 words")
    .option("--why <text>", "why the rule exists, at most 100 words")
    .option("--area <area>", "area from homeostat.yaml (default: core)")
    .option("--scope <glob>", "path glob the rule applies to; repeatable", collect)
    .option("--author <id>", "member who originated it (default: comment author or git user)")
    .option("--owner <id>", "member who answers for it (default: author)")
    .option("--id <id>", "entry id (default: from the title)")
    .option("--tag <tag>", "search tag; repeatable", collect)
    .option("--example-file <path>", "markdown to use as the Example section")
    .option("--source <type>", "manual (default) or agent-handoff")
    .option("--branch <name>", "commit to this KB branch instead of the working tree")
    .option("--push", "push --branch to origin after committing")
    .action(async (url: string | undefined, opts: LearnOptions) => {
      exitCode = await runLearn(url, opts, io);
    });

  program
    .command("search")
    .aliases(["find"])
    .description("Search accepted entries by topic or keyword.")
    .argument("<query...>", "words to search for")
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--area <area>", "only this area")
    .option("--path <path>", "only entries whose scope covers this file")
    .option("--limit <n>", "how many to show", "10")
    .option("--all", "include candidates, disputed and retired entries")
    .option("--json", "print JSON")
    .action((query: string[], opts) => {
      exitCode = runSearch(query, opts, io);
    });

  program
    .command("explain")
    .aliases(["show", "why"])
    .description("Why an entry exists: source, score breakdown, owner, conflicts, text.")
    .argument("<id>", "entry id")
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--json", "print JSON")
    .action((id: string, opts) => {
      exitCode = runExplain(id, opts, io);
    });

  program
    .command("list")
    .aliases(["ls"])
    .description("List entries with their status and score.")
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--area <area>", "only this area")
    .option("--status <status>", "only this status")
    .option("--json", "print JSON")
    .action((opts) => {
      exitCode = runList(opts, io);
    });

  program
    .command("status")
    .aliases(["report", "health"])
    .description(
      "Knowledge base health: entries by status, new, flagged, stale, duplicates, injections.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--days <n>", "window in days", "7")
    .action((opts) => {
      exitCode = runStatus(opts, io);
    });

  program
    .command("events")
    .aliases(["log"])
    .description("The KB's local event log: injections, MCP calls, captures, agent runs.")
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--since <date>", "ISO date or time (default: the last 24 hours)")
    .option("--type <type>", "only this event type; repeatable", collect)
    .option("--json", "print JSON")
    .action((opts) => {
      exitCode = runEvents(opts, io);
    });

  program
    .command("flag")
    .description("Report that an entry is wrong: it loses score and goes back to review.")
    .argument("<id>", "entry id")
    .option("--reason <text>", "what is wrong")
    .option("--dir <dir>", "knowledge base root", ".")
    .option("--by <id>", "member reporting it (default: git user)")
    .option("--branch <name>", "commit to this KB branch instead of the working tree")
    .option("--push", "push --branch to origin after committing")
    .action((id: string, opts: FlagOptions) => {
      exitCode = runFlag(id, opts, io);
    });

  program
    .command("mcp")
    .description("Serve the knowledge base to any agent over MCP (stdio).")
    .action(async () => {
      exitCode = await runMcp(io);
    });

  program
    .command("export")
    .description(
      "Write accepted entries into a code repo as Claude, Cursor, Copilot and AGENTS.md rules.",
    )
    .option("--kb <dir>", "knowledge base checkout (default: $HOMEOSTAT_DIR, else the current dir)")
    .option("--out <dir>", "code repo to write into", ".")
    .option(
      "--target <target>",
      "claude, cursor, agents-md or copilot; repeatable (default: homeostat.yaml)",
      collect,
    )
    .option("--check", "exit 1 if the exported files are out of date, without writing")
    .action((opts: ExportOptions) => {
      exitCode = runExport(opts, io);
    });

  program
    .command("curate")
    .description(
      "Draft entries from merged review feedback and open a PR on the KB repo (run in CI).",
    )
    .option("--dir <dir>", "knowledge base checkout", ".")
    .option(
      "--since <date>",
      "look at PRs merged since this date (default: agents.curator.lookbackHours ago)",
    )
    .option("--dry-run", "draft and report, but commit and open nothing")
    .action(async (opts: CurateOptions) => {
      exitCode = await runCurate(opts, io);
    });

  program
    .command("deep-dive")
    .description(
      "Merge near-duplicates, mark contradictions, retire stale entries; opens a PR (run in CI).",
    )
    .option("--dir <dir>", "knowledge base checkout", ".")
    .option("--dry-run", "report the changes, but commit and open nothing")
    .option("--no-llm", "skip Claude: no merged text and no conflict check")
    .action(async (opts: DeepDiveOptions) => {
      exitCode = await runDeepDive(opts, io);
    });

  program
    .command("up")
    .description(
      "Run the curator and deep dive on their schedules from a shared box (the dashboard comes later).",
    )
    .option("--dir <dir>", "knowledge base checkout", ".")
    .option("--once", "check the schedule once and exit")
    .option("--run-now", "run every enabled agent now and exit")
    .action(async (opts: UpOptions) => {
      exitCode = await runUp(opts, io);
    });

  program
    .command("hook", { hidden: true })
    .description(`Handle a Claude Code hook event (${HOOK_EVENTS.join(", ")}); used by the plugin.`)
    .argument("<event>")
    .action(async (event: string) => {
      exitCode = await runHook(event, io);
    });

  try {
    await program.parseAsync([...argv]);
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
  return exitCode;
}
