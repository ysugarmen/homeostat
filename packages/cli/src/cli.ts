import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type {
  Asker,
  ConflictJudge,
  Consolidator,
  DocPatcher,
  Drafter,
  DraftJudge,
  HostSetup,
  Merger,
  Provider,
  Retractor,
  RuleFixer,
  Seeder,
  TopicProposer,
  Usage,
} from "@homeostat/core";
import { VERSION } from "@homeostat/core";
import { Command, CommanderError } from "commander";
import {
  type BenchReportOptions,
  type BenchRunOptions,
  runBenchReport,
  runBenchRun,
} from "./bench.ts";
import { type BootstrapOptions, runBootstrap } from "./bootstrap.ts";
import { runCodeowners } from "./codeowners.ts";
import { type CurateOptions, runCurate } from "./curate.ts";
import { type DailyOptions, runDaily } from "./daily.ts";
import { type DeepDiveOptions, runDeepDive } from "./deep-dive.ts";
import { type DigestOptions, runDigest } from "./digest.ts";
import { type ConvertDocsOptions, runConvertDocs } from "./docs.ts";
import { runDoctor } from "./doctor.ts";
import { runEval } from "./eval-command.ts";
import { runEvents } from "./events-command.ts";
import { type ExportOptions, runExport } from "./export.ts";
import { type FlagOptions, runFlag } from "./flag.ts";
import { HOOK_EVENTS, runHook } from "./hook.ts";
import { HOSTS, type InitOptions, runInit } from "./init.ts";
import { type LearnOptions, runLearn } from "./learn.ts";
import { runMcp } from "./mcp.ts";
import { runMetrics } from "./metrics-command.ts";
import { runMigrate } from "./migrate.ts";
import { runExplain, runList, runSearch, runStatus } from "./query.ts";
import { type ReviewOptions, runReview } from "./review.ts";
import { runSeed, type SeedOptions } from "./seed.ts";
import { runSetup, type SetupOptions, STEP_NAMES } from "./setup/index.ts";
import { runSync, type SyncOptions } from "./sync.ts";
import { runDashboard, runUp, type UpOptions } from "./up.ts";
import { runValidate } from "./validate.ts";

/** Everything the commands touch outside the file system, so tests can supply their own. */
export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** Prompts for one line; absent when there is no terminal to ask. */
  ask?: (question: string) => Promise<string>;
  /** Prompts for a secret without echoing it; absent when there is no terminal to ask. */
  secret?: (question: string) => Promise<string>;
  /** Runs a program (gh, claude) and collects its output; tests pass a fake. */
  spawn?: Spawner;
  /** Test seam for `homeostat setup`: the git-host client for a token it was given. */
  hostSetup?: (host: "bitbucket" | "github", auth: HostAuth) => HostSetup;
  /** Environment variables, for tokens. Defaults to none, so tests never see real tokens. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Waits; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  /** Reads all of stdin; hooks receive their event JSON this way. */
  stdin?: () => Promise<string>;
  /**
   * Runs `homeostat <args>` detached, so a hook returns at once while a sync runs. Only the real
   * process has one; tests and embedded callers leave it out, so nothing runs behind them.
   */
  background?: (args: string[]) => void;
  /** Test seams for the agents: a git-host provider and a drafter instead of the real ones. */
  provider?: Provider;
  drafter?: Drafter;
  patcher?: DocPatcher;
  seeder?: Seeder;
  merger?: Merger;
  judge?: ConflictJudge;
  fixer?: RuleFixer;
  consolidator?: Consolidator;
  draftJudge?: DraftJudge;
  retractor?: Retractor;
  topicProposer?: TopicProposer;
  /** Test seam: a Claude runtime in place of the configured one, reporting usage as it goes. */
  runtime?: (opts: { agent: string; model: string; onUsage: (u: Usage) => void }) => Asker;
}

export interface SpawnResult {
  /** The exit code; 127 when the program is not installed. */
  code: number;
  stdout: string;
  stderr: string;
}

export type Spawner = (
  command: string,
  args: string[],
  opts?: SpawnOptions,
) => Promise<SpawnResult>;

export interface SpawnOptions {
  input?: string;
  cwd?: string;
  /** Set over this process's environment; an undefined value removes the variable. */
  env?: Record<string, string | undefined>;
  /** Stops the program after this long; the result's code is then 124. */
  timeoutMs?: number;
}

/** A git-host token, and on Bitbucket the account email that makes it an API token. */
export interface HostAuth {
  token: string;
  user?: string;
}

const spawnProcess: Spawner = (command, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let env: NodeJS.ProcessEnv | undefined;
    if (opts.env) {
      env = { ...process.env };
      for (const [k, v] of Object.entries(opts.env)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    const child = spawn(command, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(env ? { env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: e.code === "ENOENT" ? 127 : 1, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        timedOut ? { code: 124, stdout, stderr: "timed out" } : { code: code ?? 1, stdout, stderr },
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });

/**
 * Reads a line with the terminal in raw mode, echoing nothing. A paste that carries more after
 * its line break (the same token twice, say) is returned whole, so the caller can reject it
 * rather than leave the rest for the next prompt to echo.
 */
function secretTerminal(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ended) {
          value += ch;
        } else if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          ended = true;
          value += "\n";
        } else if (ch === "\u0003") {
          return finish(new Error("cancelled"));
        } else if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
      // Wait a moment for the rest of a long paste, then stop listening.
      if (ended && !timer) timer = setTimeout(() => finish(), 40);
    };
    stdin.on("data", onData);
  });
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
  ...(process.stdin.isTTY ? { ask: askTerminal, secret: secretTerminal } : {}),
  env: process.env,
  spawn: spawnProcess,
  stdin: readStdin,
  background: (args) => {
    const bin = process.argv[1];
    if (!bin) return;
    try {
      spawn(process.execPath, [bin, ...args], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // Best effort: the next hook tries again.
    }
  },
};

/** Runs the CLI with `argv` (as in `process.argv`) and returns the exit code. */
export async function runCli(argv: readonly string[], given: Io = processIo): Promise<number> {
  // HOMEOSTAT_NO_SYNC=1 keeps hooks and learn from syncing in the background (`homeostat sync` by hand still works).
  const io: Io = { ...given };
  if (given.env?.HOMEOSTAT_NO_SYNC) delete io.background;
  let exitCode = 0;
  const program = new Command("homeostat")
    .description("Team knowledge base for coding agents.")
    .version(VERSION, "-v, --version")
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
    .command("setup")
    .description(
      "Guided, re-runnable setup of a team KB: checks each step, asks only for what is missing, verifies it.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--check", "print the checklist; exit 1 if a required step is missing (safe in CI)")
    .option("--step <name>", `run one step: ${STEP_NAMES.join(", ")}`)
    .option("--join", "developer side: install the plugin, point it at this KB, check your member")
    .option("--host <host>", `git host: ${HOSTS.join(" or ")} (default: detect)`)
    .option("--repo <owner/name>", "a code repo the daily run reads; repeatable", collect)
    .option("--runtime <runtime>", "how the agents reach Claude: api, claude-code, bedrock, vertex")
    .action(async (opts: SetupOptions) => {
      exitCode = await runSetup(opts, io);
    });

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
    .option(
      "--repo <name>",
      "multi-repo KB: the rule's repo (default: the PR's, else this checkout's)",
    )
    .option("--shared", "multi-repo KB: a rule for every repo, in knowledge/core/")
    .option("--topic <name>", "topic KB: the rule's topic (default: the best match, else general)")
    .option("--scope <glob>", "path glob the rule applies to; repeatable", collect)
    .option("--author <id>", "member who originated it (default: comment author or git user)")
    .option("--owner <id>", "member who answers for it (default: author)")
    .option("--id <id>", "entry id (default: from the title)")
    .option("--tag <tag>", "search tag; repeatable", collect)
    .option(
      "--kind <kind>",
      "convention, anti-pattern, review-lesson, migration, legacy, tech-debt, practice or decision",
    )
    .option(
      "--not-adopted",
      "with --kind decision: a proposal the team rejected (rule = the proposal, why = why not)",
    )
    .option("--example-file <path>", "markdown to use as the Example section")
    .option("--doc <area/topic>", "patch one section of knowledge/<area>/docs/<topic>.md instead")
    .option("--section <id>", "with --doc: the section to replace or append to (or a new id)")
    .option("--text <text>", "with --doc: the section text")
    .option("--append", "with --doc: add to the section instead of replacing it")
    .option("--heading <text>", "with --doc: add a new section with this heading")
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

  const docs = program
    .command("docs")
    .description("Knowledge documents: the team's living reference under knowledge/<area>/docs/.");
  docs
    .command("convert")
    .description("Bring existing markdown documents into the KB, with section ids and provenance.")
    .argument("<files...>", "markdown files to convert")
    .requiredOption("--area <area>", "area the documents describe (core for org-wide)")
    .requiredOption("--owner <member>", "member who owns them")
    .option(
      "--scope <glob>",
      "paths they describe; repeatable (default: the area's globs)",
      collect,
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--force", "overwrite documents that already exist")
    .option("--repo <name>", "multi-repo KB: the repo the documents describe")
    .option("--shared", "multi-repo KB: shared documents, in knowledge/core/docs/")
    .action((files: string[], opts: ConvertDocsOptions) => {
      exitCode = runConvertDocs(files, opts, io);
    });

  program
    .command("seed")
    .description(
      "Draft a new team's first documents from a local repo checkout. Manual only: sends code to the model.",
    )
    .argument("<repo>", "path to a local checkout of the code repo")
    .requiredOption("--area <area>", "area the documents describe (core for org-wide)")
    .requiredOption("--owner <member>", "member who will own them")
    .option(
      "--topic <topic>",
      "architecture, conventions, cross-repo, data or infrastructure; repeatable",
      collect,
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--dry-run", "print exactly what would be sent; send nothing, write nothing")
    .option("--force", "replace documents that already exist")
    .option("--repo <name>", "multi-repo KB: the repo the documents describe")
    .option("--shared", "multi-repo KB: shared documents, in knowledge/core/docs/")
    .action(async (repo: string, opts: SeedOptions) => {
      exitCode = await runSeed(repo, opts, io);
    });

  program
    .command("bootstrap")
    .description(
      "Build a first base for each repo from its local checkout: existing docs, plus code, data and infrastructure documents drafted by the model. Manual only; one PR per repo.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--repo <name>", "only this repo; repeatable", collect)
    .option("--checkout <repo=path>", "where a repo is checked out; repeatable", collect)
    .option(
      "--parts <parts>",
      "docs, code, data, infrastructure (comma-separated; default all)",
      collect,
    )
    .option("--owner <member>", "member who owns the documents (default: the first reviewer)")
    .option("--dry-run", "list every file each part would read, and the cost; send nothing")
    .option("--prompts", "with --dry-run, print the full prompts")
    .option("--yes", "send without asking")
    .option("--force", "replace documents that already exist")
    .action(async (opts: BootstrapOptions) => {
      exitCode = await runBootstrap(opts, io);
    });

  program
    .command("digest")
    .description(
      "Post the weekly digest to the Slack webhook in notifications.slackWebhookEnv (run in CI).",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--days <n>", "window in days", "7")
    .option("--dry-run", "print the digest instead of posting it")
    .action(async (opts: DigestOptions) => {
      exitCode = await runDigest(opts, io);
    });

  program
    .command("daily")
    .description(
      "The daily run (CI): one PR per developer from their pending lessons and the reviews on their PRs; merges, declines or asks a reviewer by confidence.",
    )
    .option("--dir <dir>", "knowledge base checkout", ".")
    .option(
      "--since <date>",
      "read reviews on PRs merged since this date (default: agents.curator.lookbackHours ago)",
    )
    .option("--dry-run", "decide and report, but commit, open and merge nothing")
    .option(
      "--no-reviews",
      "skip drafting from review comments (no model calls): pending lessons only",
    )
    .option(
      "--max-cost <usd>",
      "stop making model calls once this run has spent this, in US dollars (default: agents.maxCostUsd)",
    )
    .action(async (opts: DailyOptions & { reviews?: boolean }) => {
      exitCode = await runDaily(
        { ...opts, ...(opts.reviews === false ? { noReviews: true } : {}) },
        io,
      );
    });

  const review = program
    .command("review")
    .description(
      "Homeostat's PRs that wait for a person, on any git host: merge to accept their lessons, close to decline.",
    );
  const kbDir = [
    "--dir <dir>",
    "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)",
  ] as const;
  review
    .command("list")
    .description("Open review PRs (and daily PRs the host refused to merge), oldest first.")
    .option(...kbDir)
    .option("--reviewer <handle>", "put the PRs that ask this reviewer first")
    .option("--json", "print JSON")
    .action(async (opts: ReviewOptions) => {
      exitCode = await runReview("list", [], opts, io);
    });
  review
    .command("show")
    .description("One PR: its lessons table, reviewers, whether it merges cleanly, and its diff.")
    .argument("<pr>", "PR number or URL")
    .option(...kbDir)
    .option("--json", "print JSON")
    .action(async (pr: string, opts: ReviewOptions) => {
      exitCode = await runReview("show", [pr], opts, io);
    });
  review
    .command("merge")
    .description("Squash-merge a PR: every lesson still in it is accepted.")
    .argument("<pr>", "PR number or URL")
    .option(...kbDir)
    .option("--json", "print JSON")
    .action(async (pr: string, opts: ReviewOptions) => {
      exitCode = await runReview("merge", [pr], opts, io);
    });
  review
    .command("close")
    .description("Close (decline) a PR with a reason: every lesson in it is declined.")
    .argument("<pr>", "PR number or URL")
    .requiredOption("--reason <text>", "why; posted on the PR for the authors")
    .option(...kbDir)
    .option("--json", "print JSON")
    .action(async (pr: string, opts: ReviewOptions) => {
      exitCode = await runReview("close", [pr], opts, io);
    });
  review
    .command("comment")
    .description("Ask the author a question on a PR and leave it open.")
    .argument("<pr>", "PR number or URL")
    .argument("<text...>", "the comment")
    .option(...kbDir)
    .action(async (pr: string, text: string[], opts: ReviewOptions) => {
      exitCode = await runReview("comment", [pr, ...text], opts, io);
    });

  program
    .command("sync")
    .description(
      "Send your pending lessons to the daily run, pull the KB and clear decided lessons. The plugin runs it for you.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--quiet", "print nothing")
    .option("--push-only", "send pending lessons, skip the pull")
    .action(async (opts: SyncOptions) => {
      exitCode = await runSync(opts, io);
    });

  program
    .command("doctor")
    .description(
      "Security review: what is read, what leaves, who can change the rules, and the blast radius.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--security", "run the security checks (the default, and today the only ones)")
    .action(async (opts: { dir?: string }) => {
      exitCode = await runDoctor(opts, io);
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
    .command("metrics")
    .description("Performance metrics: decisions, calibration, review latency, reach and runtime.")
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--days <n>", "window in days", "30")
    .option("--runs <n>", "daily runs to read", "30")
    .option("--json", "print JSON")
    .action((opts) => {
      exitCode = runMetrics(opts, io);
    });

  program
    .command("eval")
    .description(
      "Score rule selection against the KB's cases in eval/selection.yaml: hits, MRR, nDCG, recall.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--file <file>", "cases file (default: <kb>/eval/selection.yaml)")
    .option(
      "--min <floor...>",
      "fail below a floor over all cases, e.g. hit@5=0.8 mrr=0.5 served=0.9",
    )
    .option("--json", "print JSON")
    .action((opts) => {
      exitCode = runEval(opts, io);
    });

  const bench = program
    .command("bench")
    .description(
      "Before/after benchmark: the same tasks through headless Claude Code with the plugin off and on.",
    );
  bench
    .command("run")
    .description(
      "Run one condition's tasks, one call at a time, under a budget; a rerun continues where it stopped.",
    )
    .requiredOption("--tasks <file>", "task file, e.g. bench/tasks.yaml in the KB repo")
    .requiredOption("--condition <condition>", "before (plugin off) or after (plugin on)")
    .requiredOption("--budget <usd>", "stop before spending more than this, in US dollars")
    .option("--repeats <n>", "runs per task", "2")
    .option("--only <ids>", "only these task ids, comma-separated")
    .option("--out <dir>", "results folder (default: results/ next to the task file)")
    .option(
      "--judge-model <model>",
      "the judge's model (default: judge_model, else claude-opus-5-5)",
    )
    .option("--plugin <id>", "the plugin's Claude Code id, name@marketplace (default: detect)")
    .option("--repo <dir>", "the code repo checkout (default: repo: in the task file)")
    .option("--timeout <minutes>", "longest one agent call may take", "30")
    .option("--dry-run", "print what would run and an estimate; call nothing")
    .action(async (opts: BenchRunOptions) => {
      exitCode = await runBenchRun(opts, io);
    });
  bench
    .command("report")
    .description("Compare before and after: accuracy, corrections, cost, time and turns.")
    .option("--tasks <file>", "task file, to find its results/ folder")
    .option("--out <dir>", "results folder (default: bench/results)")
    .option("--json [file]", "aggregate-only JSON for a public page, to stdout or a file")
    .action((opts: BenchReportOptions) => {
      exitCode = runBenchReport(opts, io);
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
    .command("migrate")
    .description(
      "Move a one-repo KB to the multi-repo layout (knowledge/<repo>/<area>/), optionally grouping rules by topic.",
    )
    .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
    .option("--repo <name>", "one source repo: its short name (default: the repo's own name)")
    .option(
      "--map <area=repo>",
      "several repos: which repo each area moves to; repeatable",
      collect,
    )
    .option("--shared", "keep the core rules shared by every repo, in knowledge/core/")
    .option("--topics", "also group the rules into topic files, with topics the model proposes")
    .option("--dry-run", "print the plan; write nothing")
    .option("--skip-pr-check", "do not ask the host whether a review PR is open")
    .action(async (opts) => {
      exitCode = await runMigrate(opts, io);
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
    .option("--allow-public", "export even when the code repo is public")
    .option("--repo <name>", "multi-repo KB: which repo --out is, if its remote does not say")
    .action(async (opts: ExportOptions) => {
      exitCode = await runExport(opts, io);
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
    .option(
      "--show-prompts",
      "print every prompt that would be sent to the model; send none, commit nothing",
    )
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
      "Serve the dashboard and run the curator and deep dive on their schedules (a shared box).",
    )
    .option("--dir <dir>", "knowledge base checkout", ".")
    .option("--once", "check the schedule once and exit")
    .option("--run-now", "run every enabled agent now and exit")
    .option("--no-dashboard", "schedule the agents without serving the dashboard")
    .option("--port <port>", "dashboard port", "4747")
    .option("--host <host>", "dashboard interface (default 127.0.0.1; 0.0.0.0 in a container)")
    .action(async (opts: UpOptions) => {
      exitCode = await runUp(opts, io);
    });

  program
    .command("dashboard")
    .description("Serve the setup and metrics dashboard on localhost.")
    .option("--dir <dir>", "knowledge base root", ".")
    .option("--port <port>", "port", "4747")
    .option("--host <host>", "interface (default 127.0.0.1; 0.0.0.0 in a container)")
    .option(
      "--build <out>",
      "write a shared, read-only static copy into <out> instead of serving (for CI to publish)",
    )
    .action(async (opts: { dir: string; port: string; host?: string; build?: string }) => {
      exitCode = await runDashboard(opts, io);
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
