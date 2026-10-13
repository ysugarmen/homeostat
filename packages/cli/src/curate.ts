import { resolve } from "node:path";
import {
  ClaudeDrafter,
  type CuratedEntry,
  CurateError,
  type CurateResult,
  curate,
  type Provider,
  type RepoRef,
  validate,
} from "@kbx/core";
import type { Io } from "./cli.ts";
import { readKbFiles } from "./files.ts";
import { plural } from "./format.ts";
import { commitFile, git, pushBranch } from "./git.ts";
import { CliError, providerFor } from "./provider.ts";

export interface CurateOptions {
  dir: string;
  since?: string;
  dryRun?: boolean;
}

const toRepo = (ref: string): RepoRef => {
  const [owner = "", name = ""] = ref.split("/");
  return { owner, name };
};

/** First of `base`, `base-2`, ... that exists neither locally nor on origin. */
function freeBranch(root: string, base: string): string {
  const taken = (name: string) =>
    git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) !== undefined ||
    Boolean(git(root, "ls-remote", "--heads", "origin", name));
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}-${n}`;
  return name;
}

function prBody(result: CurateResult, since: Date, threshold: number): string {
  const rows = result.entries.map(({ frontmatter: fm }) => {
    const source = fm.source.url ? `[comment](${fm.source.url})` : "";
    return `| ${fm.title} | ${fm.area} | ${fm.status} | ${fm.score} | ${source} |`;
  });
  const skipped = result.skipped.map((s) => `- ${s.url}: ${s.reason}`);
  return [
    `Drafted by the kbx curator from review feedback merged since ${since.toISOString().slice(0, 10)}.`,
    "",
    "| Entry | Area | Status | Score | Source |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Accepted entries reached the auto-merge threshold (${threshold}); candidates need a reviewer to set \`approvedBy\` or retire them. Edit or delete any entry on this branch before merging.`,
    ...(skipped.length
      ? [
          "",
          `<details><summary>Skipped (${skipped.length})</summary>`,
          "",
          ...skipped,
          "",
          "</details>",
        ]
      : []),
  ].join("\n");
}

/** Opens a PR for each pushed `candidates/*` branch that is ahead of base and has none yet. */
async function openCandidatePrs(
  root: string,
  provider: Provider,
  kbRepo: RepoRef,
  base: string,
  io: Io,
) {
  git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
  git(
    root,
    "fetch",
    "--quiet",
    "origin",
    "+refs/heads/candidates/*:refs/remotes/origin/candidates/*",
  );
  const branches = (
    git(root, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/candidates/") ?? ""
  )
    .split("\n")
    .filter(Boolean)
    .map((ref) => ref.replace(/^origin\//, ""));
  if (branches.length === 0) return;

  const open = new Set((await provider.listOpenPullRequests(kbRepo)).map((pr) => pr.sourceBranch));
  for (const branch of branches) {
    const ahead = Number(git(root, "rev-list", "--count", `origin/${base}..origin/${branch}`) ?? 0);
    if (ahead === 0) continue;
    if (open.has(branch)) {
      io.stdout(`${branch} already has a PR\n`);
      continue;
    }
    const member = branch.slice("candidates/".length);
    const pr = await provider.openPullRequest(kbRepo, {
      title: `kbx: candidates from ${member}`,
      body: `Handoff notes and lessons captured in ${member}'s sessions (${plural(ahead, "commit")}). Review each entry: accept by setting \`status: accepted\` and \`approvedBy\`, or retire it.`,
      sourceBranch: branch,
      targetBranch: base,
    });
    io.stdout(`opened ${pr.url} for ${branch}\n`);
  }
}

/** `kbx curate`: the daily curator run, meant for the KB repo's scheduled CI job. */
export async function runCurate(opts: CurateOptions, io: Io): Promise<number> {
  try {
    return await curateRun(opts, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof CurateError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function curateRun(opts: CurateOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir);
  const files = readKbFiles(root);
  const config = validate(files).config;
  if (!config) throw new CliError("kbx.yaml is missing or invalid; run kbx validate");
  const sources = config.sources;
  if (!sources) throw new CliError("kbx.yaml has no sources section; the curator needs one");

  const now = io.now?.() ?? new Date();
  const since = opts.since
    ? new Date(opts.since)
    : new Date(now.getTime() - config.agents.curator.lookbackHours * 3_600_000);
  if (Number.isNaN(since.getTime())) throw new CliError(`--since "${opts.since}" is not a date`);
  const today = now.toISOString().slice(0, 10);

  const provider = providerFor(sources.host, io, "read pull requests and open the KB PR");
  const drafter =
    io.drafter ??
    new ClaudeDrafter({ model: config.agents.curator.model, effort: config.agents.curator.effort });

  const result = await curate({ files, provider, drafter, since, today });
  for (const s of result.scanned) {
    io.stdout(
      `${s.repo}: ${plural(s.pullRequests, "merged PR")}, ${plural(s.threads, "review thread")}\n`,
    );
  }
  for (const e of result.entries) {
    io.stdout(`+ ${e.path} (${e.frontmatter.status}, score ${e.frontmatter.score})\n`);
  }
  for (const s of result.skipped) io.stdout(`- ${s.url}: ${s.reason}\n`);

  const hasOrigin = git(root, "remote", "get-url", "origin") !== undefined;
  if (opts.dryRun) {
    io.stdout("dry run: nothing committed\n");
    return 0;
  }
  const kbRepo = toRepo(sources.kbRepo);
  if (result.entries.length === 0) {
    io.stdout("no new entries\n");
  } else {
    await publish(root, result.entries, {
      provider,
      kbRepo,
      base: sources.baseBranch,
      hasOrigin,
      io,
      body: prBody(result, since, config.scoring.autoMergeThreshold),
      today,
    });
  }
  if (hasOrigin) await openCandidatePrs(root, provider, kbRepo, sources.baseBranch, io);
  return 0;
}

async function publish(
  root: string,
  entries: CuratedEntry[],
  ctx: {
    provider: Provider;
    kbRepo: RepoRef;
    base: string;
    hasOrigin: boolean;
    io: Io;
    body: string;
    today: string;
  },
) {
  const branch = freeBranch(root, `kbx/curator-${ctx.today}`);
  // Start the branch from the base so the PR holds only the new entries.
  const baseRef =
    git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ctx.base}`) ??
    git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${ctx.base}`);
  if (baseRef) git(root, "branch", branch, baseRef);
  for (const e of entries) {
    commitFile(root, branch, e.path, e.text, `kbx: ${e.frontmatter.status} ${e.frontmatter.id}`);
  }
  ctx.io.stdout(`committed ${plural(entries.length, "entry", "entries")} to ${branch}\n`);
  if (!ctx.hasOrigin) {
    ctx.io.stdout("no origin remote: branch left local, no PR opened\n");
    return;
  }
  pushBranch(root, branch);
  const pr = await ctx.provider.openPullRequest(ctx.kbRepo, {
    title: `kbx: ${plural(entries.length, "knowledge entry", "knowledge entries")} from review feedback`,
    body: ctx.body,
    sourceBranch: branch,
    targetBranch: ctx.base,
  });
  ctx.io.stdout(`opened ${pr.url}\n`);
}
