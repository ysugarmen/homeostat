import { resolve } from "node:path";
import {
  ClaudeDrafter,
  ClaudeUnavailableError,
  type CuratedEntry,
  CurateError,
  type CurateResult,
  curate,
  logEvent,
  logFailure,
  type Provider,
  type RepoRef,
  readKbFiles,
  splitAutoMerge,
  validate,
} from "@homeostat/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { plural } from "./format.ts";
import { git } from "./git.ts";
import { CliError, providerFor } from "./provider.ts";
import { publish } from "./publish.ts";

export interface CurateOptions {
  dir: string;
  since?: string;
  dryRun?: boolean;
}

const toRepo = (ref: string): RepoRef => {
  const [owner = "", name = ""] = ref.split("/");
  return { owner, name };
};

type Row = { entry: CuratedEntry; reason?: string };

function prBody(
  kind: "auto" | "review",
  rows: Row[],
  result: CurateResult,
  since: Date,
  threshold: number,
): string {
  const review = kind === "review";
  const table = rows.map(({ entry: { frontmatter: fm }, reason }) => {
    const source = fm.source.url ? `[comment](${fm.source.url})` : "";
    const cells = [fm.title, fm.area, fm.status, String(fm.score), source];
    return `| ${[...cells, ...(review ? [reason ?? ""] : [])].join(" | ")} |`;
  });
  const skipped = result.skipped.map((s) => `- ${s.url}: ${s.reason}`);
  const risky = rows.flatMap(({ entry: { frontmatter: fm, risks } }) =>
    risks.map((r) => `- \`${fm.id}\`: ${r}`),
  );
  return [
    `Drafted by the homeostat curator from review feedback merged since ${since.toISOString().slice(0, 10)}.`,
    "",
    `| Entry | Area | Status | Score | Source |${review ? " Needs a reviewer because |" : ""}`,
    `| --- | --- | --- | --- | --- |${review ? " --- |" : ""}`,
    ...table,
    "",
    review
      ? `Accepted entries reached the auto-merge threshold (${threshold}) but did not pass every auto-merge gate; candidates need a reviewer to set \`approvedBy\` or retire them. Edit or delete any entry on this branch before merging.`
      : `**Auto-merged.** Every entry here passed each gate: score at or above ${threshold}, a team member's review comment followed by a code change, no secret or risky-content findings, and an area in \`scoring.autoMerge\` scope. If one is wrong, \`homeostat flag <id>\` sends it back to review.`,
    ...(risky.length
      ? [
          "",
          "**Needs a careful read.** These drafts would tell every agent on the team to do something risky. The review comment may be wrong or malicious. `validate` blocks this PR until each is deleted, edited, or signed off with `riskReviewedBy`:",
          "",
          ...risky,
        ]
      : []),
    ...(review && skipped.length
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
      title: `homeostat: candidates from ${member}`,
      body: `Handoff notes and lessons captured in ${member}'s sessions (${plural(ahead, "commit")}). Review each entry: accept by setting \`status: accepted\` and \`approvedBy\`, or retire it.\n\n**Written by an agent.** These entries come from coding sessions, where an agent may have read untrusted text (a dependency's README, an issue, a web page). Read every rule before accepting it; none of them can merge without a reviewer.`,
      sourceBranch: branch,
      targetBranch: base,
    });
    io.stdout(`opened ${pr.url} for ${branch}\n`);
  }
}

/** `homeostat curate`: the daily curator run, meant for the KB repo's scheduled CI job. */
export async function runCurate(opts: CurateOptions, io: Io): Promise<number> {
  try {
    return await curateRun(opts, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof CurateError || e instanceof ClaudeUnavailableError) {
      logFailure(opts.dir, "curator", e.message);
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
  if (!config) throw new CliError("homeostat.yaml is missing or invalid; run homeostat validate");
  const sources = config.sources;
  if (!sources) throw new CliError("homeostat.yaml has no sources section; the curator needs one");

  const now = io.now?.() ?? new Date();
  const since = opts.since
    ? new Date(opts.since)
    : new Date(now.getTime() - config.agents.curator.lookbackHours * 3_600_000);
  if (Number.isNaN(since.getTime())) throw new CliError(`--since "${opts.since}" is not a date`);
  const today = now.toISOString().slice(0, 10);

  const provider = providerFor(sources.host, io, "read pull requests and open the KB PR");
  const drafter = io.drafter ?? new ClaudeDrafter(askerFor(config, "curator", io));

  const result = await curate({ files, provider, drafter, since, today });
  logEvent(root, {
    ts: now.toISOString(),
    type: "agent-run",
    agent: "curator",
    ok: true,
    summary: `${result.entries.length} drafted, ${result.skipped.length} skipped`,
    entries: result.entries.map((e) => e.frontmatter.id),
    scanned: result.scanned,
  });
  for (const s of result.scanned) {
    io.stdout(
      `${s.repo}: ${plural(s.pullRequests, "merged PR")}, ${plural(s.threads, "review thread")}\n`,
    );
  }
  for (const e of result.entries) {
    io.stdout(`+ ${e.path} (${e.frontmatter.status}, score ${e.frontmatter.score})\n`);
  }
  for (const s of result.skipped) io.stdout(`- ${s.url}: ${s.reason}\n`);
  if (result.redacted) {
    io.stdout(`redacted ${result.redacted} secret(s) from review threads before drafting\n`);
  }

  const hasOrigin = git(root, "remote", "get-url", "origin") !== undefined;
  if (opts.dryRun) {
    io.stdout("dry run: nothing committed\n");
    return 0;
  }
  const kbRepo = toRepo(sources.kbRepo);
  const threshold = config.scoring.autoMergeThreshold;
  const { auto, review } = splitAutoMerge(result.entries, config);
  const entriesNoun = (n: number) => plural(n, "knowledge entry", "knowledge entries");
  const changes = (entries: CuratedEntry[]) =>
    entries.map((e) => ({
      path: e.path,
      text: e.text,
      message: `homeostat: ${e.frontmatter.status} ${e.frontmatter.id}`,
    }));
  if (result.entries.length === 0) io.stdout("no new entries\n");
  if (auto.length > 0) {
    const { pr } = await publish({
      root,
      branch: `homeostat/curator-${today}-auto`,
      changes: changes(auto),
      provider,
      kbRepo,
      base: sources.baseBranch,
      title: `homeostat: auto-merge ${entriesNoun(auto.length)} from review feedback`,
      body: prBody(
        "auto",
        auto.map((entry) => ({ entry })),
        result,
        since,
        threshold,
      ),
      io,
    });
    // The required CI check has not run yet, so validate the merged result here first.
    const merged = validate({ ...files, ...Object.fromEntries(auto.map((e) => [e.path, e.text])) });
    if (pr && !merged.ok) {
      io.stdout(
        `not auto-merging ${pr.url}: the knowledge base would not validate; it stays open for a reviewer\n`,
      );
    } else if (pr) {
      try {
        await provider.mergePullRequest(kbRepo, pr.id);
        io.stdout(`auto-merged ${pr.url}\n`);
        logEvent(root, {
          ts: now.toISOString(),
          type: "auto-merged",
          url: pr.url,
          entries: auto.map((e) => e.frontmatter.id),
        });
      } catch (e) {
        io.stdout(
          `could not auto-merge ${pr.url}: ${(e as Error).message}\nit stays open for a reviewer; see branch protection in homeostat init's output\n`,
        );
      }
    }
  }
  if (review.length > 0) {
    await publish({
      root,
      branch: `homeostat/curator-${today}`,
      changes: changes(review.map((r) => r.entry)),
      provider,
      kbRepo,
      base: sources.baseBranch,
      title: `homeostat: ${entriesNoun(review.length)} from review feedback`,
      body: prBody("review", review, result, since, threshold),
      io,
    });
  }
  if (hasOrigin) await openCandidatePrs(root, provider, kbRepo, sources.baseBranch, io);
  return 0;
}
