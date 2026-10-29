import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, readState, VERSION, wantedSchedules } from "@homeostat/core";
import { plural } from "./format.ts";
import type { SetupContext } from "./setup/context.ts";

/**
 * Misconfigurations nothing fails on: a run keeps going, but quietly does less than the team
 * thinks. `homeostat doctor` and `homeostat setup --check` both list them, each with its fix.
 * A check that cannot be made from here (no token, no admin) says nothing.
 */

/** The KB's CI files: the GitHub workflows and the Bitbucket pipelines. */
export function ciFiles(root: string): string[] {
  return [
    ...(existsSync(join(root, ".github/workflows"))
      ? readdirSync(join(root, ".github/workflows")).map((f) => `.github/workflows/${f}`)
      : []),
    ...(existsSync(join(root, "bitbucket-pipelines.yml")) ? ["bitbucket-pipelines.yml"] : []),
  ];
}

/** Every place a CI file runs homeostat, with the version it pins, if any. */
export function ciRuns(root: string): { path: string; spec: string; version?: string }[] {
  const runs: { path: string; spec: string; version?: string }[] = [];
  for (const path of ciFiles(root)) {
    const text = readFileSync(join(root, path), "utf8");
    // Only command lines (npx, dlx, a run: step or a script list item): a job's `name:` or a
    // `git config user.name "homeostat deep-dive"` line reads the same but runs nothing.
    for (const m of text.matchAll(
      /(?:\bnpx(?:\s+(?:--yes|-y))?|\bdlx|\brun:|^\s*-)\s+homeostat(@[^\s"']*)?\s+(validate|daily|curate|deep-dive|digest|export)\b/gm,
    )) {
      const version = m[1]?.slice(1);
      runs.push({
        path,
        spec: `homeostat${m[1] ?? ""}`,
        ...(version && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version) ? { version } : {}),
      });
    }
  }
  return runs;
}

/** Whether exact version `a` is older than `b`; a pre-release counts as its release. */
export function olderThan(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0]?.split(".").map(Number) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

/** CI files pinning a homeostat older than this CLI: they run what an upgrade meant to replace. */
function staleCi(root: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of ciRuns(root)) {
    if (!r.version || !olderThan(r.version, VERSION) || seen.has(`${r.path} ${r.version}`))
      continue;
    seen.add(`${r.path} ${r.version}`);
    out.push(
      `${r.path} runs homeostat@${r.version}, older than this CLI (${VERSION}): change it to homeostat@${VERSION} and commit, or the daily run keeps the old behaviour`,
    );
  }
  return out;
}

/** The last daily run ran out of judge calls: the lessons it skipped went to a reviewer instead. */
function judgeCap(root: string, config: Config): string[] {
  const base = config.sources?.baseBranch ?? "main";
  const last = readState(root, 1, base).runs.at(-1);
  if (!last) return [];
  const unjudged = last.lessons.filter((l) => l.reason.includes("judgeCalls reached")).length;
  if (!unjudged) return [];
  return [
    `the last daily run (${last.at.slice(0, 10)}) reached agents.curator.judgeCalls (${config.agents.curator.judgeCalls}): ${plural(unjudged, "lesson")} it would have merged went to a reviewer unjudged; raise agents.curator.judgeCalls in homeostat.yaml`,
  ];
}

/** notifications.slackWebhookEnv names a variable CI does not have: nothing is posted. */
async function slackVariable(ctx: SetupContext, config: Config): Promise<string[]> {
  const name = config.notifications.slackWebhookEnv;
  if (!name || ctx.storedNow.has(name)) return [];
  if ((await ctx.secretPresent([name])) !== false) return [];
  const where =
    config.sources?.host === "github" ? "an Actions secret" : "a Bitbucket repository variable";
  return [
    `notifications.slackWebhookEnv is ${name}, but ${name} is not stored as ${where}: the digest and the morning notice post nowhere; store it with homeostat setup --step slack`,
  ];
}

/** Bitbucket schedules on another branch than sources.baseBranch, or disabled. */
async function schedules(ctx: SetupContext, config: Config): Promise<string[]> {
  const kb = ctx.kbRepo();
  if (config.sources?.host !== "bitbucket" || !kb) return [];
  const api = ctx.admin ? ctx.client("bitbucket", ctx.admin) : ctx.reader();
  if (!api?.listSchedules) return [];
  let have: Awaited<ReturnType<NonNullable<typeof api.listSchedules>>>;
  try {
    have = await api.listSchedules(kb);
  } catch {
    return [];
  }
  const base = config.sources.baseBranch;
  const out: string[] = [];
  for (const w of wantedSchedules(config)) {
    if (ctx.scheduledNow.has(w.pipeline)) continue;
    const mine = have.filter((h) => h.pipeline === w.pipeline);
    const onBase = mine.filter((h) => h.branch === base);
    if (onBase.some((h) => h.enabled)) continue;
    if (onBase.length)
      out.push(
        `the ${w.pipeline} schedule on ${base} is disabled, so it never runs: enable it in Repository settings > Pipelines > Schedules, or run homeostat setup --step schedules`,
      );
    else if (mine.length)
      out.push(
        `${w.pipeline} is scheduled on ${[...new Set(mine.map((h) => h.branch))].join(", ")}, not on ${base} (sources.baseBranch), so it runs another branch's KB: run homeostat setup --step schedules to schedule it on ${base}`,
      );
  }
  return out;
}

/** Every quiet misconfiguration found, as one message each, the fix included. */
export async function quietMisconfigurations(
  root: string,
  config: Config,
  ctx: SetupContext,
): Promise<string[]> {
  return [
    ...(await slackVariable(ctx, config)),
    ...(await schedules(ctx, config)),
    ...judgeCap(root, config),
    ...staleCi(root),
  ];
}
