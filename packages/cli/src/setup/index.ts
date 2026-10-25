import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE,
  memberFromGit,
  parseConfig,
  SETUP_STEPS,
  type SetupCheck,
  writeSetupRecord,
} from "@homeostat/core";
import type { Io } from "../cli.ts";
import { git } from "../git.ts";
import { type SetupContext as Ctx, SetupContext, type SetupFlags, type Step } from "./context.ts";
import { areasStep } from "./steps/areas.ts";
import { bootstrapStep, teammatesStep } from "./steps/bootstrap.ts";
import { codeownersStep } from "./steps/codeowners.ts";
import { commitStep } from "./steps/commit.ts";
import { hostStep } from "./steps/host.ts";
import { modelStep } from "./steps/model.ts";
import { reposStep } from "./steps/repos.ts";
import { reviewersStep } from "./steps/reviewers.ts";
import { schedulesStep } from "./steps/schedules.ts";
import { slackStep } from "./steps/slack.ts";
import { teamStep } from "./steps/team.ts";
import { tokenStep } from "./steps/token.ts";

/** The checklist, in the order `SETUP_STEPS` lists it. */
export const STEPS: readonly Step[] = [
  hostStep,
  tokenStep,
  reposStep,
  areasStep,
  teamStep,
  reviewersStep,
  modelStep,
  slackStep,
  schedulesStep,
  codeownersStep,
  commitStep,
  bootstrapStep,
  teammatesStep,
];

export interface SetupOptions extends SetupFlags {
  dir?: string;
  check?: boolean;
  step?: string;
  join?: boolean;
}

const isOpen = (c: SetupCheck) => c.state === "missing" || c.state === "broken";

function mark(ctx: Ctx, c: SetupCheck): string {
  if (c.state === "done") return ctx.paint("green", "✓");
  if (c.state === "optional") return ctx.paint("dim", "○");
  if (c.state === "unknown") return ctx.paint("yellow", "?");
  return ctx.paint("red", "✗");
}

function line(ctx: Ctx, step: Step, c: SetupCheck): string {
  const n = STEPS.indexOf(step) + 1;
  const tag = step.info.required ? "" : ctx.paint("dim", " (optional)");
  // An optional step that is not set says what you lose without it.
  const why = c.state === "optional" ? step.info.why : c.reason;
  return `  ${mark(ctx, c)} ${String(n).padStart(2)}. ${step.info.title}${tag}${why ? ctx.paint("dim", ` · ${why}`) : ""}`;
}

async function detectAll(ctx: Ctx): Promise<Map<Step, SetupCheck>> {
  const out = new Map<Step, SetupCheck>();
  for (const step of STEPS) out.set(step, await safeDetect(ctx, step));
  return out;
}

async function safeDetect(ctx: Ctx, step: Step): Promise<SetupCheck> {
  try {
    return await step.detect(ctx);
  } catch (e) {
    return { state: "unknown", reason: ctx.redact((e as Error).message) };
  }
}

/** Records every settled result for the dashboard; an "unknown" never overwrites a real check. */
function record(ctx: Ctx, results: Map<Step, SetupCheck>, now: Date) {
  const settled: Record<string, SetupCheck> = {};
  for (const [step, c] of results) if (c.state !== "unknown") settled[step.info.name] = c;
  if (!existsSync(join(ctx.root, CONFIG_FILE))) return;
  try {
    writeSetupRecord(ctx.root, settled, now);
  } catch {
    // The record is a convenience for the dashboard; a read-only checkout goes without.
  }
}

function printChecklist(ctx: Ctx, results: Map<Step, SetupCheck>) {
  for (const [step, c] of results) ctx.say(line(ctx, step, c));
  const left = [...results].filter(([s, c]) => s.info.required && isOpen(c));
  ctx.say(
    left.length
      ? `\n${left.length} required ${left.length === 1 ? "step" : "steps"} left: ${left.map(([s]) => s.info.name).join(", ")}`
      : "\nEvery required step is done.",
  );
}

/** `homeostat setup`: the guided, re-runnable checklist for a team's knowledge base. */
export async function runSetup(opts: SetupOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const ctx = new SetupContext(root, io, opts);
  const now = io.now?.() ?? new Date();
  if (opts.join) return runJoin(ctx, now);

  if (opts.check || !ctx.interactive) {
    const results = await detectAll(ctx);
    printChecklist(ctx, results);
    record(ctx, results, now);
    if (!opts.check) {
      ctx.say(
        "\nNo terminal, so nothing was asked. Run homeostat setup in a terminal; these supply what it would ask for:",
      );
      for (const [step, c] of results)
        if (c.state !== "done" && step.supply) ctx.say(`  ${step.info.name}: ${step.supply}`);
    }
    return [...results].some(([s, c]) => s.info.required && isOpen(c)) ? 1 : 0;
  }

  if (opts.step) {
    const step = STEPS.find((s) => s.info.name === opts.step);
    if (!step) {
      io.stderr(
        `unknown step "${opts.step}"; one of ${STEPS.map((s) => s.info.name).join(", ")}\n`,
      );
      return 1;
    }
    const before = await safeDetect(ctx, step);
    ctx.say(line(ctx, step, before));
    if (before.state !== "done" || (await ctx.yes("  Already done. Do it again?"))) {
      await step.run(ctx);
      const after = await safeDetect(ctx, step);
      ctx.say(line(ctx, step, after));
      record(ctx, new Map([[step, after]]), now);
      return step.info.required && after.state !== "done" ? 1 : 0;
    }
    return 0;
  }

  ctx.say(`homeostat setup in ${root}\n`);
  const results = new Map<Step, SetupCheck>();
  for (const step of STEPS) {
    let c = await safeDetect(ctx, step);
    ctx.say(line(ctx, step, c));
    let go = isOpen(c);
    if (c.state === "optional")
      go = await ctx.yes(`  ${step.info.title} is optional. Set it up now?`);
    else if (c.state === "unknown")
      go = await ctx.yes(`  ${step.info.title}: cannot check it from here. Set it up now?`);
    if (go) {
      await step.run(ctx);
      c = await safeDetect(ctx, step);
      ctx.say(line(ctx, step, c));
    }
    results.set(step, c);
    // Every later step needs the config, the host and the KB repo.
    if (step === hostStep && c.state !== "done") {
      ctx.say(
        "\nStopped: the rest needs the KB repo and host. Fix the above and rerun homeostat setup.",
      );
      record(ctx, results, now);
      return 1;
    }
  }
  ctx.say("");
  printChecklist(ctx, results);
  record(ctx, results, now);
  return [...results].some(([s, r]) => s.info.required && isOpen(r)) ? 1 : 0;
}

const PLUGIN = "homeostat@homeostat";

/**
 * `homeostat setup --join`, the developer side: the plugin installed, its kb_dir pointed at this
 * checkout, and the git name matched to a member. Asks nothing, so it runs without a terminal.
 */
async function runJoin(ctx: Ctx, now: Date): Promise<number> {
  const ok = (t: string) => ctx.say(`  ${ctx.paint("green", "✓")} ${t}`);
  const bad = (t: string) => ctx.say(`  ${ctx.paint("red", "✗")} ${t}`);
  const text = ctx.configText();
  const config = text === undefined ? undefined : parseConfig(text).config;
  if (!config) {
    bad(`no valid ${CONFIG_FILE} here: run setup --join in your clone of the team's KB repo`);
    return 1;
  }
  let failed = false;
  const manual = `    claude plugin marketplace add ysugarmen/homeostat\n    claude plugin install ${PLUGIN}`;

  if ((await ctx.run("claude", ["--version"])).code !== 0) {
    bad(`Claude Code is not installed (https://claude.com/claude-code). Then:\n${manual}`);
    failed = true;
  } else {
    const list = await ctx.run("claude", ["plugin", "list", "--json"]);
    let installed = false;
    try {
      installed = (JSON.parse(list.stdout) as { id?: string }[]).some((p) => p.id === PLUGIN);
    } catch {
      installed = false;
    }
    if (installed) ok("the homeostat plugin is installed");
    else {
      await ctx.run("claude", ["plugin", "marketplace", "add", "ysugarmen/homeostat"]);
      const r = await ctx.run("claude", ["plugin", "install", PLUGIN]);
      if (r.code === 0) ok("installed the homeostat plugin");
      else {
        bad(`could not install the plugin; run:\n${manual}`);
        failed = true;
      }
    }
    if (!failed) {
      const current = await ctx.run("claude", ["plugin", "configure", PLUGIN, "--json"]);
      let dir: string | undefined;
      try {
        dir = (JSON.parse(current.stdout) as { inputs?: { kb_dir?: string } }).inputs?.kb_dir;
      } catch {
        dir = undefined;
      }
      if (dir && resolve(dir) === ctx.root) ok(`kb_dir is ${ctx.root}`);
      else {
        const set = await ctx.run(
          "claude",
          ["plugin", "configure", PLUGIN, "--values-stdin"],
          JSON.stringify({ kb_dir: ctx.root }),
        );
        if (set.code === 0) ok(`set the plugin's kb_dir to ${ctx.root}`);
        else {
          bad(
            `could not set kb_dir from here: in Claude Code, /plugin > homeostat > Configure, set kb_dir to\n    ${ctx.root}\n  (or export HOMEOSTAT_DIR=${ctx.root})`,
          );
          failed = true;
        }
      }
    }
  }

  const name = git(ctx.root, "config", "user.name");
  const id = memberFromGit(config.team.members, name);
  if (config.team.members.some((m) => m.id === id))
    ok(`your git name "${name}" is the member ${id}`);
  else {
    bad(
      `your git name "${name ?? ""}" is no member of the team: ask a lead to add you (homeostat setup --step team), or set git config user.name to your member id`,
    );
    failed = true;
  }
  try {
    writeSetupRecord(
      ctx.root,
      {
        join: failed
          ? { state: "missing", reason: "see homeostat setup --join" }
          : { state: "done", reason: `plugin and kb_dir set; member ${id}` },
      },
      now,
    );
  } catch {
    // Only the dashboard reads it.
  }
  ctx.say(
    failed
      ? "\nFix the above and rerun homeostat setup --join."
      : "\nDone: start a Claude Code session in any code repo.",
  );
  return failed ? 1 : 0;
}

/** Every step's name, for the --step help text. */
export const STEP_NAMES = SETUP_STEPS.map((s) => s.name);
