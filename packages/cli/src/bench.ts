import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AGENT_ENV,
  aggregateBench,
  BENCH_CONDITIONS,
  BENCH_JUDGE_MODEL,
  type BenchCoding,
  type BenchCondition,
  type BenchMeasure,
  type BenchQuestion,
  type BenchRecord,
  type BenchTaskFile,
  type BenchTokens,
  type ClaudeRun,
  CODING_JUDGE_SYSTEM,
  CODING_VERDICT_JSON_SCHEMA,
  claudeCodeArgs,
  codingJudgePrompt,
  codingVerdictSchema,
  isLimitError,
  parseBenchResults,
  parseBenchTasks,
  parseClaudeRun,
  publicBenchSummary,
  QUESTION_JUDGE_SYSTEM,
  QUESTION_VERDICT_JSON_SCHEMA,
  questionJudgePrompt,
  questionVerdictSchema,
  readVerdict,
} from "@homeostat/core";
import type { Io, SpawnOptions, SpawnResult } from "./cli.ts";
import { painter, plural } from "./format.ts";

export interface BenchRunOptions {
  tasks: string;
  condition: string;
  repeats?: string;
  budget?: string;
  only?: string;
  out?: string;
  dryRun?: boolean;
  judgeModel?: string;
  plugin?: string;
  repo?: string;
  timeout?: string;
}

export interface BenchReportOptions {
  tasks?: string;
  out?: string;
  json?: string | boolean;
}

/** The plugin's id in Claude Code (`name@marketplace`) when `claude plugin list` cannot say. */
export const DEFAULT_PLUGIN_ID = "homeostat@homeostat";

/** Kinds of call, each with its own cost estimate. */
type CallKind = "question" | "coding" | "feedback" | "judge";

/**
 * What a call costs before the run has seen one of its kind: generous on purpose, since the
 * estimate decides whether the next call may start.
 */
export const DEFAULT_ESTIMATES: Record<CallKind, number> = {
  question: 1,
  coding: 3,
  feedback: 1.5,
  judge: 0.3,
};

/** An observed cost is scaled by this to make the next call's estimate. */
const ESTIMATE_MARGIN = 1.5;

/** How much failed test output goes back to the agent. */
export const FEEDBACK_CHARS = 2500;

/**
 * The settings that turn the plugin off for one call: `--settings` is layered over the user's
 * own settings files for that process only, so the user's settings are never written.
 */
export function pluginOffSettings(pluginId: string): string {
  return JSON.stringify({ enabledPlugins: { [pluginId]: false } });
}

/** The plugin's MCP tools: allowed in both conditions so headless runs can use them when present. */
export function pluginMcpTools(pluginId: string): string {
  const name = pluginId.split("@")[0] || "homeostat";
  return `mcp__plugin_${name}_homeostat`;
}

/** Arguments for one agent call: the same in both conditions except the plugin switch. */
export function agentArgs(p: {
  prompt: string;
  model: string;
  condition: BenchCondition;
  pluginId: string;
  permissionMode?: string | undefined;
  maxBudgetUsd: number;
  resume?: string | undefined;
}): string[] {
  return [
    "-p",
    p.prompt,
    ...(p.resume ? ["--resume", p.resume] : []),
    "--output-format",
    "json",
    "--model",
    p.model,
    "--allowedTools",
    pluginMcpTools(p.pluginId),
    ...(p.permissionMode ? ["--permission-mode", p.permissionMode] : []),
    "--max-budget-usd",
    p.maxBudgetUsd.toFixed(2),
    ...(p.condition === "before" ? ["--settings", pluginOffSettings(p.pluginId)] : []),
  ];
}

/** The environment for an agent call: "before" also tells the plugin's hooks to stand down. */
export const agentEnv = (condition: BenchCondition): Record<string, string> | undefined =>
  condition === "before" ? { [AGENT_ENV]: "1" } : undefined;

/** Why a run stopped before the end. */
class BenchStop extends Error {
  readonly reason: "budget" | "limit" | "broken";
  constructor(reason: "budget" | "limit" | "broken", message: string) {
    super(message);
    this.reason = reason;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);
const firstLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 300) ?? "";

interface CallResult {
  status: "ok" | "error" | "timeout";
  run: ClaudeRun | null;
  cost: number;
  estimated: boolean;
}

interface RunContext {
  io: Io;
  spawn: NonNullable<Io["spawn"]>;
  tasks: BenchTaskFile;
  tasksDir: string;
  repoDir: string;
  condition: BenchCondition;
  judgeModel: string;
  pluginId: string;
  budget: number;
  spent: number;
  observed: Partial<Record<CallKind, number>>;
  timeoutMs: number;
}

function estimate(ctx: Pick<RunContext, "observed">, kind: CallKind): number {
  const seen = ctx.observed[kind];
  return seen === undefined ? DEFAULT_ESTIMATES[kind] : seen * ESTIMATE_MARGIN;
}

function observe(ctx: RunContext, kind: CallKind, cost: number) {
  if (cost > (ctx.observed[kind] ?? 0)) ctx.observed[kind] = cost;
}

/** Stops the run unless `need` more dollars fit in what is left. */
function ensureBudget(ctx: RunContext, need: number, what: string) {
  if (ctx.spent + need > ctx.budget)
    throw new BenchStop(
      "budget",
      `budget reached: ${what} is estimated at ${usd(need)}, and ${usd(ctx.spent)} of ${usd(ctx.budget)} is spent`,
    );
}

/** One `claude -p` call, counted against the budget; stops the run on a limit or a broken CLI. */
async function callClaude(
  ctx: RunContext,
  kind: CallKind,
  args: (maxBudgetUsd: number) => string[],
  opts: SpawnOptions,
): Promise<CallResult> {
  const est = estimate(ctx, kind);
  ensureBudget(ctx, est, `the next ${kind} call`);
  const r: SpawnResult = await ctx.spawn("claude", args(ctx.budget - ctx.spent), opts);
  if (r.code === 127)
    throw new BenchStop("broken", "Claude Code (claude) is not installed or not on the PATH");
  if (r.code === 124) {
    // No result, so no reported cost: the estimate stands in for it.
    ctx.spent += est;
    return { status: "timeout", run: null, cost: est, estimated: true };
  }
  const run = parseClaudeRun(r.stdout);
  if (run) {
    ctx.spent += run.costUsd;
    observe(ctx, kind, run.costUsd);
  }
  const failed = !run || run.isError || r.code !== 0;
  if (failed && isLimitError(run, r.stdout, r.stderr))
    throw new BenchStop(
      "limit",
      `Claude Code hit a rate or usage limit: ${firstLine(run?.result || r.stderr || r.stdout)}`,
    );
  if (!run)
    throw new BenchStop(
      "broken",
      `claude failed (exit ${r.code}): ${firstLine(r.stderr || r.stdout) || "no output"}`,
    );
  if (run.isError && /budget/i.test(run.subtype))
    throw new BenchStop("budget", `a call reached --max-budget-usd (${run.subtype})`);
  return { status: run.isError ? "error" : "ok", run, cost: run.costUsd, estimated: false };
}

/**
 * The judge: a bare structured call on its own model with the plugin off, retried once when the
 * reply is unusable. Each attempt is counted in the budget.
 */
async function judge<T>(
  ctx: RunContext,
  system: string,
  user: string,
  jsonSchema: object,
  read: (structured: unknown, text: string) => T | null,
): Promise<{ verdict: T | null; cost: number; estimated: boolean }> {
  let cost = 0;
  let estimated = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callClaude(
      ctx,
      "judge",
      (max) => [
        ...claudeCodeArgs({ model: ctx.judgeModel, effort: "medium" }, system, jsonSchema),
        "--settings",
        pluginOffSettings(ctx.pluginId),
        "--max-budget-usd",
        max.toFixed(2),
      ],
      {
        input: user,
        cwd: tmpdir(),
        env: { [AGENT_ENV]: "1" },
        timeoutMs: Math.min(ctx.timeoutMs, 600_000),
      },
    );
    cost += r.cost;
    estimated ||= r.estimated;
    if (r.status !== "ok" || !r.run) continue;
    const verdict = read(r.run.structured, r.run.result);
    if (verdict !== null) return { verdict, cost, estimated };
  }
  return { verdict: null, cost, estimated };
}

const zeroTokens = (): BenchTokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

/** Sums the agent's calls: cost, time, turns, tokens. */
class AgentTally {
  cost = 0;
  durationMs = 0;
  turns = 0;
  tokens = zeroTokens();
  estimated = false;
  sessionId: string | undefined;
  add(r: CallResult) {
    this.cost += r.cost;
    this.estimated ||= r.estimated;
    if (!r.run) return;
    this.durationMs += r.run.durationMs;
    this.turns += r.run.turns;
    this.tokens.input += r.run.tokens.input;
    this.tokens.output += r.run.tokens.output;
    this.tokens.cacheRead += r.run.tokens.cacheRead;
    this.tokens.cacheCreation += r.run.tokens.cacheCreation;
    this.sessionId = r.run.sessionId ?? this.sessionId;
  }
}

interface Outcome {
  record: BenchRecord;
  transcript: string;
}

function baseRecord(
  ctx: RunContext,
  task: { id: string },
  kind: "question" | "coding",
  repeat: number,
  agent: AgentTally,
  judgeCost: number,
  judgeEstimated: boolean,
): BenchRecord {
  return {
    v: 1,
    condition: ctx.condition,
    id: task.id,
    kind,
    repeat,
    at: (ctx.io.now?.() ?? new Date()).toISOString(),
    model: ctx.tasks.model,
    judgeModel: ctx.judgeModel,
    agentCostUsd: round(agent.cost),
    judgeCostUsd: round(judgeCost),
    costUsd: round(agent.cost + judgeCost),
    ...(agent.estimated || judgeEstimated ? { costEstimated: true } : {}),
    durationMs: agent.durationMs,
    turns: agent.turns,
    tokens: agent.tokens,
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

const failure = (r: CallResult) =>
  r.status === "timeout" ? "timeout" : r.status === "error" ? r.run?.subtype || "error" : undefined;

async function runQuestion(ctx: RunContext, q: BenchQuestion, repeat: number): Promise<Outcome> {
  ensureBudget(
    ctx,
    estimate(ctx, "question") + estimate(ctx, "judge"),
    `question ${q.id} (agent and judge)`,
  );
  const agent = new AgentTally();
  const r = await callClaude(
    ctx,
    "question",
    (max) =>
      agentArgs({
        prompt: q.prompt,
        model: ctx.tasks.model,
        condition: ctx.condition,
        pluginId: ctx.pluginId,
        maxBudgetUsd: max,
      }),
    { cwd: ctx.repoDir, env: agentEnv(ctx.condition), timeoutMs: ctx.timeoutMs },
  );
  agent.add(r);
  const answer = r.run?.result ?? "";
  let error = failure(r);
  let score: number | null = 0;
  let reason = "no answer";
  let judged = { cost: 0, estimated: false };
  if (answer.trim()) {
    const j = await judge(
      ctx,
      QUESTION_JUDGE_SYSTEM,
      questionJudgePrompt(q, answer),
      QUESTION_VERDICT_JSON_SCHEMA,
      (s, t) => readVerdict(questionVerdictSchema, s, t),
    );
    judged = j;
    score = j.verdict?.score ?? null;
    reason = j.verdict?.reason ?? "the judge gave no usable verdict";
    if (!j.verdict) error ??= "judge-unusable";
  }
  const record: BenchRecord = {
    ...baseRecord(ctx, q, "question", repeat, agent, judged.cost, judged.estimated),
    score,
    ...(error ? { error } : {}),
  };
  const transcript = [
    `# ${q.id} (${ctx.condition}, repeat ${repeat})`,
    `## Prompt\n\n${q.prompt}`,
    `## Answer\n\n${answer || "(none)"}`,
    `## Judge\n\nscore: ${score ?? "none"}\n\n${reason}`,
  ].join("\n\n");
  return { record, transcript: `${transcript}\n` };
}

async function git(ctx: RunContext, args: string[], opts: SpawnOptions = {}) {
  return ctx.spawn("git", args, { timeoutMs: 120_000, ...opts });
}

async function addWorktree(ctx: RunContext, path: string, base: string) {
  const r = await git(ctx, ["-C", ctx.repoDir, "worktree", "add", "--detach", path, base]);
  if (r.code !== 0)
    throw new BenchStop("broken", `git worktree add ${base} failed: ${firstLine(r.stderr)}`);
}

async function removeWorktree(ctx: RunContext, path: string) {
  await git(ctx, ["-C", ctx.repoDir, "worktree", "remove", "--force", path]);
  rmSync(path, { recursive: true, force: true });
}

/** The agent's change against the base, new files included, without the hidden test paths. */
async function agentDiff(ctx: RunContext, work: string, base: string, exclude: string[]) {
  await git(ctx, ["add", "-A"], { cwd: work });
  const r = await git(
    ctx,
    ["diff", "--cached", "--binary", base, "--", ".", ...exclude.map((p) => `:(exclude)${p}`)],
    { cwd: work },
  );
  return r.code === 0 ? r.stdout : "";
}

/** Applies the diff to a clean copy, adds the hidden tests and runs the command. */
async function runHiddenTests(
  ctx: RunContext,
  task: BenchCoding,
  diff: string,
  dir: string,
): Promise<{ pass: boolean; output: string }> {
  const tests = task.grade.tests as NonNullable<BenchCoding["grade"]["tests"]>;
  await addWorktree(ctx, dir, task.base);
  try {
    if (diff.trim()) {
      const a = await git(ctx, ["apply", "--binary", "--whitespace=nowarn", "-"], {
        cwd: dir,
        input: diff,
      });
      if (a.code !== 0)
        return { pass: false, output: `the change does not apply cleanly:\n${a.stderr}` };
    }
    for (const [path, fixture] of Object.entries(tests.files)) {
      const to = join(dir, path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(resolve(ctx.tasksDir, fixture), to);
    }
    const r = await ctx.spawn("sh", ["-c", tests.cmd], {
      cwd: dir,
      timeoutMs: tests.timeout * 1000,
    });
    const output = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
    if (r.code === 124)
      return { pass: false, output: `${output}\n(timed out after ${tests.timeout}s)` };
    return { pass: r.code === 0, output };
  } finally {
    await removeWorktree(ctx, dir);
  }
}

export const feedbackPrompt = (output: string) =>
  `The tests failed. The end of their output:\n\n\`\`\`\n${tail(output, FEEDBACK_CHARS)}\n\`\`\`\n\nFix the code (not the tests), then stop.`;

async function runCoding(ctx: RunContext, task: BenchCoding, repeat: number): Promise<Outcome> {
  const tests = task.grade.tests;
  const judgeSpec = task.grade.judge;
  ensureBudget(
    ctx,
    estimate(ctx, "coding") + (judgeSpec ? estimate(ctx, "judge") : 0),
    `coding task ${task.id}`,
  );
  const tmp = mkdtempSync(join(tmpdir(), "homeostat-bench-"));
  const work = join(tmp, "work");
  const agent = new AgentTally();
  const lines = [
    `# ${task.id} (${ctx.condition}, repeat ${repeat})`,
    `## Prompt\n\n${task.prompt}`,
  ];
  const args = (prompt: string, max: number, resume?: string) =>
    agentArgs({
      prompt,
      model: ctx.tasks.model,
      condition: ctx.condition,
      pluginId: ctx.pluginId,
      permissionMode: ctx.tasks.permission_mode ?? "acceptEdits",
      maxBudgetUsd: max,
      resume,
    });
  const callOpts = { cwd: work, env: agentEnv(ctx.condition), timeoutMs: ctx.timeoutMs };
  await addWorktree(ctx, work, task.base);
  try {
    const first = await callClaude(ctx, "coding", (max) => args(task.prompt, max), callOpts);
    agent.add(first);
    let error = failure(first);
    const exclude = tests ? Object.keys(tests.files) : [];

    if (tests) {
      let corrections = 0;
      let pass = false;
      let firstTry = false;
      for (let round = 0; ; round++) {
        const diff = await agentDiff(ctx, work, task.base, exclude);
        const t = await runHiddenTests(ctx, task, diff, join(tmp, `grade-${round}`));
        lines.push(`## Diff (round ${round})\n\n\`\`\`diff\n${diff}\n\`\`\``);
        lines.push(
          `## Tests (round ${round}): ${t.pass ? "pass" : "fail"}\n\n\`\`\`\n${tail(t.output, FEEDBACK_CHARS)}\n\`\`\``,
        );
        if (t.pass) {
          pass = true;
          firstTry = round === 0;
          break;
        }
        if (corrections >= task.max_feedback || !agent.sessionId || error === "timeout") break;
        const fb = await callClaude(
          ctx,
          "feedback",
          (max) => args(feedbackPrompt(t.output), max, agent.sessionId),
          callOpts,
        );
        corrections++;
        agent.add(fb);
        error = failure(fb) ?? error;
      }
      const record: BenchRecord = {
        ...baseRecord(ctx, task, "coding", repeat, agent, 0, false),
        grade: "tests",
        outcome: pass ? "solved" : "unsolved",
        solved: pass,
        repeatedMistake: !firstTry,
        corrections,
        ...(error ? { error } : {}),
      };
      return { record, transcript: `${lines.join("\n\n")}\n` };
    }

    const spec = judgeSpec as NonNullable<typeof judgeSpec>;
    const diff = await agentDiff(ctx, work, task.base, exclude);
    lines.push(`## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``);
    const j = await judge(
      ctx,
      CODING_JUDGE_SYSTEM,
      codingJudgePrompt(task, spec, diff),
      CODING_VERDICT_JSON_SCHEMA,
      (s, t) => readVerdict(codingVerdictSchema, s, t),
    );
    const outcome = j.verdict?.outcome ?? null;
    if (!j.verdict) error ??= "judge-unusable";
    lines.push(`## Judge\n\noutcome: ${outcome ?? "none"}\n\n${j.verdict?.reason ?? ""}`);
    const record: BenchRecord = {
      ...baseRecord(ctx, task, "coding", repeat, agent, j.cost, j.estimated),
      grade: "judge",
      outcome,
      solved: outcome === "ok",
      repeatedMistake: outcome === null ? null : outcome === "repeated-mistake",
      corrections: 0,
      ...(error ? { error } : {}),
    };
    return { record, transcript: `${lines.join("\n\n")}\n` };
  } finally {
    await removeWorktree(ctx, work);
    await git(ctx, ["-C", ctx.repoDir, "worktree", "prune"]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface Pending {
  kind: "question" | "coding";
  task: BenchQuestion | BenchCoding;
  repeat: number;
}

function loadTasks(file: string, io: Io): BenchTaskFile | null {
  if (!existsSync(file)) {
    io.stderr(`no task file at ${file}\n`);
    return null;
  }
  const { tasks, issues } = parseBenchTasks(readFileSync(file, "utf8"));
  if (!tasks) {
    io.stderr(`${file}:\n${issues.map((i) => `  ${i.message}`).join("\n")}\n`);
    return null;
  }
  return tasks;
}

const outDirFor = (tasksFile: string | undefined, out: string | undefined) =>
  resolve(out ?? join(dirname(resolve(tasksFile ?? "bench/tasks.yaml")), "results"));

function readRecords(path: string): BenchRecord[] {
  return existsSync(path) ? parseBenchResults(readFileSync(path, "utf8")).records : [];
}

/** The largest per-call costs already seen in earlier runs, so estimates start from real numbers. */
function observedFrom(records: readonly BenchRecord[]): Partial<Record<CallKind, number>> {
  const o: Partial<Record<CallKind, number>> = {};
  const bump = (k: CallKind, v: number) => {
    if (v > 0 && v > (o[k] ?? 0)) o[k] = v;
  };
  for (const r of records) {
    if (r.costEstimated) continue;
    bump(r.kind, r.agentCostUsd / (1 + (r.corrections ?? 0)));
    if (r.corrections) bump("feedback", r.agentCostUsd / (1 + r.corrections));
    bump("judge", r.judgeCostUsd);
  }
  return o;
}

/** Reads `claude plugin list --json` (no model call) to find the plugin and whether it is on. */
async function findPlugin(
  ctx: Pick<RunContext, "spawn">,
  wanted: string | undefined,
): Promise<{ id: string; listed: boolean; found: boolean; enabled?: boolean }> {
  const r = await ctx.spawn("claude", ["plugin", "list", "--json"], { timeoutMs: 60_000 });
  let list: { id?: string; enabled?: boolean }[] | undefined;
  try {
    const parsed = JSON.parse(r.stdout);
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    // Older Claude Code: fall through.
  }
  if (!list) return { id: wanted ?? DEFAULT_PLUGIN_ID, listed: false, found: false };
  const hit = wanted
    ? list.find((p) => p.id === wanted)
    : list.find((p) => typeof p.id === "string" && p.id.startsWith("homeostat@"));
  if (!hit?.id) return { id: wanted ?? DEFAULT_PLUGIN_ID, listed: true, found: false };
  return {
    id: hit.id,
    listed: true,
    found: true,
    ...(hit.enabled !== undefined ? { enabled: hit.enabled } : {}),
  };
}

/** `homeostat bench run`: one condition's runs, sequentially, under a budget; resumable. */
export async function runBenchRun(opts: BenchRunOptions, io: Io): Promise<number> {
  const condition = opts.condition as BenchCondition;
  if (!BENCH_CONDITIONS.includes(condition)) {
    io.stderr("--condition must be before or after\n");
    return 1;
  }
  const budget = Number(opts.budget);
  if (!(budget > 0)) {
    io.stderr("--budget must be a positive amount in US dollars, e.g. --budget 5\n");
    return 1;
  }
  const repeats = Number(opts.repeats ?? 2);
  if (!Number.isInteger(repeats) || repeats < 1) {
    io.stderr("--repeats must be a whole number of at least 1\n");
    return 1;
  }
  const timeoutMin = Number(opts.timeout ?? 30);
  if (!(timeoutMin > 0)) {
    io.stderr("--timeout must be a positive number of minutes\n");
    return 1;
  }
  const tasksFile = resolve(opts.tasks);
  const tasks = loadTasks(tasksFile, io);
  if (!tasks) return 1;
  const tasksDir = dirname(tasksFile);
  const repoDir = resolve(opts.repo ? resolve(opts.repo) : resolve(tasksDir, tasks.repo));
  const outDir = outDirFor(tasksFile, opts.out);
  const only = opts.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allIds = [...tasks.questions, ...tasks.coding].map((t) => t.id);
  const unknown = only?.filter((id) => !allIds.includes(id)) ?? [];
  if (unknown.length) {
    io.stderr(`--only: no task ${unknown.map((u) => `"${u}"`).join(", ")} in ${tasksFile}\n`);
    return 1;
  }
  const missingFixtures = tasks.coding.flatMap((t) =>
    Object.values(t.grade.tests?.files ?? {})
      .filter((f) => !existsSync(resolve(tasksDir, f)))
      .map((f) => `${t.id}: ${f}`),
  );
  if (missingFixtures.length) {
    io.stderr(
      `hidden test files not found (paths are relative to the task file):\n  ${missingFixtures.join("\n  ")}\n`,
    );
    return 1;
  }
  if (!existsSync(repoDir)) {
    io.stderr(`no code repo at ${repoDir} (repo: in the task file, or --repo)\n`);
    return 1;
  }

  const resultsFile = join(outDir, `${condition}.jsonl`);
  const existing = readRecords(resultsFile);
  const done = new Set(existing.map((r) => `${r.id}#${r.repeat}`));
  const otherModels = [...new Set(existing.map((r) => r.model))].filter((m) => m !== tasks.model);
  if (otherModels.length)
    io.stderr(
      `warning: ${resultsFile} has runs on ${otherModels.join(", ")}; this run uses ${tasks.model}\n`,
    );
  const selected = (t: { id: string }) => !only || only.includes(t.id);
  const pending: Pending[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const q of tasks.questions.filter(selected))
      if (!done.has(`${q.id}#${repeat}`)) pending.push({ kind: "question", task: q, repeat });
    for (const c of tasks.coding.filter(selected))
      if (!done.has(`${c.id}#${repeat}`)) pending.push({ kind: "coding", task: c, repeat });
  }
  const judgeModel = opts.judgeModel ?? tasks.judge_model ?? BENCH_JUDGE_MODEL;
  if (judgeModel === tasks.model)
    io.stderr(`warning: the judge runs on the agents' own model (${judgeModel})\n`);

  const observed = observedFrom([
    ...existing,
    ...readRecords(join(outDir, `${other(condition)}.jsonl`)),
  ]);
  const est = (k: CallKind) => estimate({ observed }, k);
  let expected = 0;
  let worst = 0;
  for (const p of pending) {
    const c = p.kind === "coding" ? (p.task as BenchCoding) : undefined;
    const base = est(p.kind) + (c?.grade.tests ? 0 : est("judge"));
    expected += base;
    worst += base + (c?.grade.tests ? c.max_feedback * est("feedback") : 0);
  }
  const paint = painter(io);
  const head = `${condition}: ${plural(pending.length, "run")} to go (${done.size} already in ${resultsFile}), model ${tasks.model}, judge ${judgeModel}`;

  if (opts.dryRun) {
    io.stdout(`${head}\n`);
    for (const p of pending) {
      const c = p.kind === "coding" ? (p.task as BenchCoding) : undefined;
      const how = c
        ? c.grade.tests
          ? `tests, up to ${c.max_feedback} corrections`
          : "judge"
        : "judge";
      io.stdout(`  r${p.repeat}  ${p.kind.padEnd(8)} ${p.task.id}  (${how})\n`);
    }
    io.stdout(
      `\nEstimate: about ${usd(expected)}, at most ${usd(worst)} with every correction, against --budget ${usd(budget)}.\n` +
        `The estimates are deliberately high: ${Object.entries(DEFAULT_ESTIMATES)
          .map(([k]) => `${k} ${usd(est(k as CallKind))}`)
          .join(
            ", ",
          )} per call${Object.keys(observed).length ? " (from earlier runs)" : " (defaults; no runs yet)"}.\n` +
        `Plugin: ${condition === "before" ? "off for these calls (--settings enabledPlugins false)" : "on (your normal setup)"}. Nothing was sent.\n`,
    );
    return 0;
  }
  if (!pending.length) {
    io.stdout(`${head}\nNothing to run. Compare with homeostat bench report.\n`);
    return 0;
  }

  const spawn = io.spawn;
  if (!spawn) {
    io.stderr("cannot run programs here\n");
    return 1;
  }
  // Preflight, no model calls: the plugin's id and state, the repo and its commits.
  const plugin = await findPlugin({ spawn }, opts.plugin);
  if (plugin.listed && !plugin.found) {
    io.stderr(
      `the plugin ${plugin.id} is not installed in Claude Code, so both conditions would run without it. Install it, or pass --plugin <name@marketplace>.\n`,
    );
    return 1;
  }
  if (condition === "after" && plugin.enabled === false) {
    io.stderr(
      `the plugin ${plugin.id} is disabled in your Claude Code settings: "after" would run without it. Enable it (claude plugin enable ${plugin.id}) and run again.\n`,
    );
    return 1;
  }
  if (!plugin.listed)
    io.stderr(`warning: could not list Claude Code plugins; assuming the plugin is ${plugin.id}\n`);
  const ctx: RunContext = {
    io,
    spawn,
    tasks,
    tasksDir,
    repoDir,
    condition,
    judgeModel,
    pluginId: plugin.id,
    budget,
    spent: 0,
    observed,
    timeoutMs: timeoutMin * 60_000,
  };
  const bases = [
    ...new Set(pending.filter((p) => p.kind === "coding").map((p) => (p.task as BenchCoding).base)),
  ];
  for (const base of bases) {
    const r = await git(ctx, [
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      "--quiet",
      `${base}^{commit}`,
    ]);
    if (r.code !== 0) {
      io.stderr(`commit ${base} is not in ${repoDir}: fetch it, or fix base: in the task file\n`);
      return 1;
    }
  }

  const transcripts = join(outDir, `${condition}-transcripts`);
  mkdirSync(transcripts, { recursive: true });
  const ignore = join(outDir, ".gitignore");
  if (!existsSync(ignore))
    writeFileSync(ignore, "# Answers and diffs stay on this machine.\n*-transcripts/\n");

  io.stdout(
    `${head}\nBudget ${usd(budget)}; plugin ${condition === "before" ? `off (${plugin.id} disabled for each call)` : `on (${plugin.id})`}.\n`,
  );
  let finished = 0;
  let stop: BenchStop | undefined;
  for (const p of pending) {
    try {
      const out =
        p.kind === "question"
          ? await runQuestion(ctx, p.task as BenchQuestion, p.repeat)
          : await runCoding(ctx, p.task as BenchCoding, p.repeat);
      appendFileSync(resultsFile, `${JSON.stringify(out.record)}\n`);
      writeFileSync(join(transcripts, `${p.task.id}-r${p.repeat}.md`), out.transcript);
      finished++;
      const r = out.record;
      const result =
        r.kind === "question"
          ? `score ${r.score ?? "-"}`
          : `${r.outcome ?? "-"}${r.grade === "tests" ? `, ${plural(r.corrections ?? 0, "correction")}` : ""}`;
      io.stdout(
        `  r${p.repeat} ${p.task.id}: ${result}, ${usd(r.costUsd)}, ${(r.durationMs / 1000).toFixed(0)}s, ${plural(r.turns, "turn")}${r.error ? paint("yellow", ` (${r.error})`) : ""}\n`,
      );
    } catch (e) {
      if (!(e instanceof BenchStop)) throw e;
      stop = e;
      break;
    }
  }
  const left = pending.length - finished;
  io.stdout(
    `\n${plural(finished, "run")} done, ${usd(ctx.spent)} spent of ${usd(budget)}${left ? `; ${plural(left, "run")} left` : ""}. Results: ${resultsFile}\n`,
  );
  if (stop) {
    io.stderr(
      `${paint(stop.reason === "budget" ? "yellow" : "red", "stopped")}: ${stop.message}\n`,
    );
    io.stderr(
      stop.reason === "limit"
        ? "Everything finished so far is saved. Run the same command after the limit resets to continue.\n"
        : "Everything finished so far is saved. Run the same command again to continue.\n",
    );
    return stop.reason === "budget" ? 0 : 1;
  }
  return 0;
}

const other = (c: BenchCondition): BenchCondition => (c === "before" ? "after" : "before");

function fmt(unit: BenchMeasure["unit"], v: number | null, signed = false): string {
  if (v === null || !Number.isFinite(v)) return "-";
  const sign = signed && v > 0 ? "+" : "";
  switch (unit) {
    case "share":
      return `${sign}${(v * 100).toFixed(1)}${signed ? "pp" : "%"}`;
    case "usd":
      return `${sign}${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(3)}`;
    case "seconds":
      return `${sign}${v.toFixed(1)}s`;
    default:
      return `${sign}${v.toFixed(2)}`;
  }
}

export function formatBenchReport(
  before: readonly BenchRecord[],
  after: readonly BenchRecord[],
  io: Io,
): string {
  const paint = painter(io);
  const measures = aggregateBench(before, after);
  const s = publicBenchSummary(before, after, io.now?.() ?? new Date());
  const lines = [
    `Bench: ${plural(s.runs.before, "run")} before, ${plural(s.runs.after, "run")} after; ${plural(s.tasks.questions, "question")}, ${plural(s.tasks.coding, "coding task")}; repeats ${s.repeats.before}/${s.repeats.after}`,
    `Model ${s.models.join(", ") || "-"}, judge ${s.judgeModels.join(", ") || "-"}; ${s.dates.first ?? "-"} to ${s.dates.last ?? "-"}`,
    "",
  ];
  const cols = ["", "before med", "mean", "after med", "mean", "change", "95% CI", "spread b/a"];
  const widths = [30, 11, 9, 11, 9, 10, 20, 18];
  const row = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 10) : c.padStart(widths[i] ?? 10)))
      .join("");
  lines.push(paint("bold", row(cols)));
  for (const m of measures) {
    if (!m.before.runs && !m.after.runs) continue;
    lines.push(
      row([
        m.label,
        fmt(m.unit, m.before.median),
        fmt(m.unit, m.before.mean),
        fmt(m.unit, m.after.median),
        fmt(m.unit, m.after.mean),
        fmt(m.unit, m.delta, true),
        m.ci95 ? `[${fmt(m.unit, m.ci95[0], true)}, ${fmt(m.unit, m.ci95[1], true)}]` : "-",
        `${fmt(m.unit, m.before.spread)}/${fmt(m.unit, m.after.spread)}`,
      ]),
    );
  }
  const errors = new Map<string, number>();
  for (const r of [...before, ...after])
    if (r.error)
      errors.set(`${r.condition} ${r.error}`, (errors.get(`${r.condition} ${r.error}`) ?? 0) + 1);
  lines.push(
    "",
    paint(
      "dim",
      "Per task: the mean of its repeats; med and mean are over tasks. change: after minus before over tasks run in both, with a bootstrap 95% interval. spread: the mean range across a task's repeats.",
    ),
  );
  if (errors.size)
    lines.push(
      paint("yellow", `Unfinished runs: ${[...errors].map(([k, n]) => `${k} ${n}`).join(", ")}`),
    );
  return `${lines.join("\n")}\n`;
}

/** `homeostat bench report`: both conditions side by side; `--json` for a public page. */
export function runBenchReport(opts: BenchReportOptions, io: Io): number {
  const outDir = outDirFor(opts.tasks, opts.out);
  const before = readRecords(join(outDir, "before.jsonl"));
  const after = readRecords(join(outDir, "after.jsonl"));
  if (!before.length && !after.length) {
    io.stderr(`no results in ${outDir}: run homeostat bench run first, or pass --out\n`);
    return 1;
  }
  if (opts.json !== undefined && opts.json !== false) {
    const json = `${JSON.stringify(publicBenchSummary(before, after, io.now?.() ?? new Date()), null, 2)}\n`;
    if (typeof opts.json === "string") {
      writeFileSync(resolve(opts.json), json);
      io.stdout(`wrote ${resolve(opts.json)}\n`);
    } else io.stdout(json);
    return 0;
  }
  io.stdout(formatBenchReport(before, after, io));
  return 0;
}
