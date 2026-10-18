import { resolve } from "node:path";
import {
  type Provider,
  ProviderError,
  type PullRequestDetails,
  type RepoRef,
  readKbFiles,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { painter } from "./format.ts";
import { findKb } from "./hook.ts";
import { CliError, providerFor } from "./provider.ts";

/**
 * `homeostat review`: the human side of the daily run, the same on every git host. It acts only on
 * homeostat's own PRs into the KB's base branch; the next daily run records the outcome from the
 * host, as it does for a PR merged or closed in the browser.
 */
export interface ReviewOptions {
  dir?: string;
  json?: boolean;
  /** `list`: put the PRs that ask this reviewer (a login or nickname, @ optional) first. */
  reviewer?: string;
  /** `close`: why the lessons are declined; posted on the PR. */
  reason?: string;
}

/** Review PRs hold the middle band; a daily PR is open only when the host refused to merge it. */
const BRANCH = /^homeostat\/(review|daily)-(.+)-(\d{4}-\d{2}-\d{2})$/;
/** A flagged rule's PR: merging puts its fix in force, closing retires the rule. */
const DISPUTE = /^homeostat\/review-dispute-(.+)-(\d{4}-\d{2}-\d{2})$/;

interface Queued {
  id: number;
  title: string;
  url: string;
  kind: "review" | "daily" | "dispute";
  /** The developer whose lessons these are; for a dispute, the flagged rule's id instead. */
  member: string;
  date: string;
  lessons: number;
  reviewers: string[];
  createdAt: string;
  conflicts?: boolean;
}

interface Context {
  provider: Provider;
  kbRepo: RepoRef;
  base: string;
}

function context(opts: ReviewOptions, io: Io): Context {
  const root = opts.dir ? resolve(opts.dir) : findKb(io.env, process.cwd());
  if (!root)
    throw new CliError(
      "no knowledge base here: pass --dir, set HOMEOSTAT_DIR, or run inside the KB repo",
    );
  const config = validate(readKbFiles(root)).config;
  if (!config)
    throw new CliError(`homeostat.yaml is missing or invalid in ${root}; run homeostat validate`);
  const sources = config.sources;
  if (!sources)
    throw new CliError("homeostat.yaml has no sources section, so no KB repo to review");
  const [owner = "", name = ""] = sources.kbRepo.split("/");
  return {
    provider: providerFor(sources.host, io, "review homeostat's pull requests"),
    kbRepo: { owner, name },
    base: sources.baseBranch,
  };
}

/** `12`, `#12`, or the PR's URL. */
function prNumber(ref: string): number {
  const n = /^#?(\d+)$/.exec(ref.trim())?.[1] ?? /\/(\d+)\/?(?:[#?].*)?$/.exec(ref.trim())?.[1];
  if (!n) throw new CliError(`"${ref}" is not a pull request number or URL`);
  return Number(n);
}

/** Lessons the PR carries, from the table the daily run writes into its body. */
const lessonCount = (pr: PullRequestDetails, kind: Queued["kind"]) =>
  pr.body.split("\n").filter((l) => l.startsWith(`| ${kind === "review" ? "review" : "merged"} |`))
    .length;

function queued(pr: PullRequestDetails): Queued | undefined {
  const base = {
    id: pr.id,
    title: pr.title.replace(/^homeostat: /, ""),
    url: pr.url,
    reviewers: pr.reviewers.map((r) => r.id),
    createdAt: pr.createdAt,
    ...(pr.conflicts === undefined ? {} : { conflicts: pr.conflicts }),
  };
  const d = DISPUTE.exec(pr.sourceBranch);
  if (d) return { ...base, kind: "dispute", member: d[1] ?? "", date: d[2] ?? "", lessons: 1 };
  const m = BRANCH.exec(pr.sourceBranch);
  if (!m) return undefined;
  const kind = m[1] as Queued["kind"];
  return {
    id: pr.id,
    title: pr.title.replace(/^homeostat: /, ""),
    url: pr.url,
    kind,
    member: m[2] ?? "",
    date: m[3] ?? "",
    lessons: lessonCount(pr, kind),
    reviewers: pr.reviewers.map((r) => r.id),
    createdAt: pr.createdAt,
    ...(pr.conflicts === undefined ? {} : { conflicts: pr.conflicts }),
  };
}

/** Loads a PR and refuses anything but an open homeostat PR into the KB's base branch. */
async function homeostatPr(ctx: Context, ref: string, action: string) {
  const pr = await ctx.provider.getPullRequest(ctx.kbRepo, prNumber(ref));
  if (!BRANCH.test(pr.sourceBranch) || pr.targetBranch !== ctx.base)
    throw new CliError(
      `#${pr.id} is not one of homeostat's PRs (${pr.sourceBranch} into ${pr.targetBranch}); homeostat review only ${action}s homeostat/review-* and homeostat/daily-* PRs into ${ctx.base}`,
    );
  if (pr.state !== "open") throw new CliError(`#${pr.id} is already ${pr.state}`);
  return pr;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function conflictHelp(pr: PullRequestDetails): string {
  return [
    `#${pr.id} conflicts with ${pr.targetBranch}, so it cannot be merged as it is. Usually ${pr.targetBranch} gained the same file since the daily run opened it. Either:`,
    `  - update its branch and merge again:`,
    `      git fetch origin && git switch ${pr.sourceBranch}`,
    `      git rebase origin/${pr.targetBranch}   # keep the newer text of each conflicting lesson`,
    `      git push --force-with-lease`,
    `  - or, if ${pr.targetBranch} already has these lessons, close it: homeostat review close ${pr.id} --reason "already on ${pr.targetBranch}"`,
    "",
  ].join("\n");
}

export async function runReview(
  action: "list" | "show" | "merge" | "close" | "comment",
  args: string[],
  opts: ReviewOptions,
  io: Io,
): Promise<number> {
  try {
    const ctx = context(opts, io);
    switch (action) {
      case "list":
        return await list(ctx, opts, io);
      case "show":
        return await show(ctx, args[0] ?? "", opts, io);
      case "merge":
        return await merge(ctx, args[0] ?? "", opts, io);
      case "close":
        return await close(ctx, args[0] ?? "", opts, io);
      case "comment":
        return await comment(ctx, args[0] ?? "", args.slice(1).join(" "), io);
    }
  } catch (e) {
    if (e instanceof CliError || e instanceof ProviderError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function list(ctx: Context, opts: ReviewOptions, io: Io): Promise<number> {
  const open = (await ctx.provider.listOpenPullRequests(ctx.kbRepo)).filter(
    (p) => BRANCH.test(p.sourceBranch) && p.targetBranch === ctx.base,
  );
  const details = await Promise.all(open.map((p) => ctx.provider.getPullRequest(ctx.kbRepo, p.id)));
  const me = opts.reviewer?.replace(/^@/, "").toLowerCase();
  const asksMe = (q: Queued) => (me && q.reviewers.some((r) => r.toLowerCase() === me) ? 0 : 1);
  const queue = details
    .flatMap((pr) => queued(pr) ?? [])
    .sort((a, b) => asksMe(a) - asksMe(b) || a.createdAt.localeCompare(b.createdAt));

  if (opts.json) {
    io.stdout(`${JSON.stringify(queue, null, 2)}\n`);
    return 0;
  }
  if (queue.length === 0) {
    io.stdout("nothing to review: no homeostat PR is waiting\n");
    return 0;
  }
  const paint = painter(io);
  const lessons = queue.reduce((n, q) => n + q.lessons, 0);
  io.stdout(`${plural(queue.length, "PR")} with ${plural(lessons, "lesson")} to review:\n`);
  for (const q of queue) {
    const notes = [
      q.kind === "daily" ? "the host refused to merge this daily PR" : "",
      q.kind === "dispute" ? `flagged rule ${q.member}: merge the fix, or close to retire it` : "",
      q.reviewers.length ? `asks ${q.reviewers.map((r) => `@${r}`).join(", ")}` : "",
      q.conflicts ? paint("red", `conflicts with ${ctx.base}`) : "",
    ].filter(Boolean);
    io.stdout(
      `  #${q.id} ${q.title} (${plural(q.lessons, "lesson")})${notes.length ? ` · ${notes.join(" · ")}` : ""}\n     ${q.url}\n`,
    );
  }
  return 0;
}

async function show(ctx: Context, ref: string, opts: ReviewOptions, io: Io): Promise<number> {
  const pr = await ctx.provider.getPullRequest(ctx.kbRepo, prNumber(ref));
  if (!queued(pr) || pr.targetBranch !== ctx.base)
    throw new CliError(`#${pr.id} is not one of homeostat's PRs (${pr.sourceBranch})`);
  const diff = await ctx.provider.getPullRequestDiff(ctx.kbRepo, pr.id);
  if (opts.json) {
    io.stdout(`${JSON.stringify({ ...pr, diff }, null, 2)}\n`);
    return 0;
  }
  const mergeable =
    pr.conflicts === undefined
      ? "the host has not worked out yet whether it merges cleanly"
      : pr.conflicts
        ? `conflicts with ${pr.targetBranch}`
        : "merges cleanly";
  io.stdout(
    [
      `#${pr.id} ${pr.title} (${pr.state})`,
      pr.url,
      `${pr.sourceBranch} into ${pr.targetBranch} · ${pr.reviewers.length ? `asks ${pr.reviewers.map((r) => `@${r.id}`).join(", ")} · ` : ""}${mergeable}`,
      "",
      pr.body,
      "",
      diff,
    ].join("\n"),
  );
  if (!diff.endsWith("\n")) io.stdout("\n");
  return 0;
}

async function merge(ctx: Context, ref: string, opts: ReviewOptions, io: Io): Promise<number> {
  const pr = await homeostatPr(ctx, ref, "merge");
  if (pr.conflicts) {
    io.stderr(conflictHelp(pr));
    return 1;
  }
  try {
    await ctx.provider.mergePullRequest(ctx.kbRepo, pr.id);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    io.stderr(
      `the host refused to merge #${pr.id}: ${e.message.replace(/^.*?: /, "")}\nIf ${pr.targetBranch} needs an approval or a passing build first, give it on the PR (${pr.url}) and merge again.\n`,
    );
    return 1;
  }
  const q = queued(pr);
  const n = q?.lessons ?? 0;
  const result = { merged: pr.id, url: pr.url, lessons: n };
  io.stdout(
    opts.json
      ? `${JSON.stringify(result)}\n`
      : q?.kind === "dispute"
        ? `merged #${pr.id}: the fix for ${q.member} is accepted and the rule is back in force. The next daily run records it.\n`
        : `merged #${pr.id}: its ${plural(n, "lesson")} ${n === 1 ? "is" : "are"} accepted. The next daily run records it and tells the authors' sessions.\n`,
  );
  return 0;
}

async function close(ctx: Context, ref: string, opts: ReviewOptions, io: Io): Promise<number> {
  const reason = opts.reason?.trim();
  if (!reason) throw new CliError("say why with --reason; it is posted on the PR for the authors");
  const pr = await homeostatPr(ctx, ref, "close");
  await ctx.provider.commentOnPullRequest(ctx.kbRepo, pr.id, `Declined in review: ${reason}`);
  await ctx.provider.closePullRequest(ctx.kbRepo, pr.id);
  const q = queued(pr);
  const n = q?.lessons ?? 0;
  io.stdout(
    opts.json
      ? `${JSON.stringify({ closed: pr.id, url: pr.url, lessons: n, reason })}\n`
      : q?.kind === "dispute"
        ? `closed #${pr.id}: ${q.member} is retired (${reason}). The next daily run records it.\n`
        : `closed #${pr.id}: its ${plural(n, "lesson")} ${n === 1 ? "is" : "are"} declined (${reason}). The next daily run records it.\n`,
  );
  return 0;
}

async function comment(ctx: Context, ref: string, text: string, io: Io): Promise<number> {
  if (!text.trim()) throw new CliError("give the comment text after the PR number");
  const pr = await homeostatPr(ctx, ref, "comment on");
  await ctx.provider.commentOnPullRequest(ctx.kbRepo, pr.id, text.trim());
  io.stdout(`commented on #${pr.id}; it stays open\n`);
  return 0;
}
