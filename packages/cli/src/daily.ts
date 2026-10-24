import { resolve } from "node:path";
import {
  ClaudeDocPatcher,
  ClaudeDrafter,
  ClaudeRuleFixer,
  type Confidence,
  type Config,
  type CuratedEntry,
  candidatesBranch,
  comparable,
  confidence,
  curate,
  type DecisionRecord,
  type DecisionsFile,
  decisionsPath,
  type Entry,
  explainConfidence,
  findRule,
  fixProblems,
  flagEntry,
  HEARTBEAT_PATH,
  isDocPath,
  kbSnapshot,
  lessonHash,
  logEvent,
  loginKey,
  type OpenPullRequest,
  overlayPending,
  parseDoc,
  parseEntry,
  REVIEW_REMINDER_DAYS,
  type RepoRef,
  type RunReport,
  readKbFiles,
  resolveDispute,
  STATE_BRANCH,
  sameLesson,
  validate,
} from "@homeostat/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { plural } from "./format.ts";
import { commitTree, forcePush, git, mergeText, showFile } from "./git.ts";
import { foldChanges, nudgeBranch, refFiles, showRule } from "./kb-write.ts";
import { CliError, providerFor } from "./provider.ts";
import { type FileChange, publish } from "./publish.ts";

/**
 * `homeostat daily`: the one scheduled job (the KB repo's CI, or `homeostat up`). Laptops need not
 * be on: it reads only what is already on the server. For each developer it:
 *
 * 1. takes their pending lessons (pushed to `candidates/<member>` by their sync) and the lessons
 *    drafted from review comments on their own merged PRs
 * 2. scores each lesson (confidence, step 3): merge, decline, or a reviewer
 * 3. opens ONE daily PR with the confident lessons and merges it, every decision explained
 * 4. opens a review PR for the uncertain ones, asking the area's owners to review
 * 5. records decisions, heartbeats and a run report on `homeostat/state`, which the developers'
 *    sync reads to clear decided lessons, and the dashboard reads to show it all
 *
 * It also settles earlier review PRs: merged by a reviewer means merged, closed means declined.
 */
export interface DailyOptions {
  dir?: string;
  since?: string;
  dryRun?: boolean;
  /** Skip drafting from review comments (no model calls): pending lessons only. */
  noReviews?: boolean;
}

interface Lesson {
  member: string;
  path: string;
  /** The text the daily PR commits. */
  text: string;
  /** Hash of the text as submitted, which the developer's sync matches on. */
  hash: string;
  id: string;
  title: string;
  kind: "new" | "update" | "flag" | "doc" | "dispute" | "retire";
  origin: "pending" | "review";
  originator: string;
  url?: string;
  decision: DecisionRecord["decision"];
  reason: string;
  confidence?: Confidence;
  duplicateOf?: string;
  /** Another developer's daily PR commits this change, combined with theirs. */
  carriedBy?: string;
  /** Filed under general: the topic the drafter would add for it. */
  suggestedTopic?: string;
}

const repoRef = (ref: string): RepoRef => {
  const [owner = "", name = ""] = ref.split("/");
  return { owner, name };
};

const accepted = (text: string) => text.replace(/^status: candidate$/m, "status: accepted");

export async function runDaily(opts: DailyOptions, io: Io): Promise<number> {
  try {
    return await daily(opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function daily(opts: DailyOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? ".");
  const files = readKbFiles(root);
  const kb = validate(files);
  const config = kb.config;
  if (!config) throw new CliError("homeostat.yaml is missing or invalid; run homeostat validate");
  const sources = config.sources;
  if (!sources)
    throw new CliError("homeostat.yaml has no sources section; the daily run needs one");
  const base = sources.baseBranch;
  const kbRepo = repoRef(sources.kbRepo);
  const now = io.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const stats = { calls: 0, chars: 0, failed: 0 };
  const provider = providerFor(sources.host, io, "read pull requests and open the daily PRs");
  const remote = (ref: string) => `refs/remotes/origin/${ref}`;

  git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:${remote(base)}`);
  git(
    root,
    "fetch",
    "--quiet",
    "origin",
    "+refs/heads/candidates/*:refs/remotes/origin/candidates/*",
  );
  git(root, "fetch", "--quiet", "origin", `+refs/heads/${STATE_BRANCH}:${remote(STATE_BRANCH)}`);
  const onState = (path: string) => git(root, "show", `${remote(STATE_BRANCH)}:${path}`);
  // A rule's path reads through its topic file when the KB groups rules by topic.
  const onBase = (path: string) => showRule(root, remote(base), path);
  // Each PR is folded onto the latest base: an earlier PR of this run may have merged since.
  const onFreshBase = (changes: FileChange[]) => {
    git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:${remote(base)}`);
    return foldChanges(root, remote(base), changes, config);
  };

  const members = config.team.members.map((m) => m.id);
  const decisions = new Map<string, DecisionsFile>();
  for (const m of members) {
    try {
      decisions.set(m, JSON.parse(onState(decisionsPath(m)) ?? "") as DecisionsFile);
    } catch {
      decisions.set(m, { member: m, decided: [] });
    }
  }

  // Settle review PRs from earlier runs that a reviewer has since merged or closed.
  const open = new Set(
    (await provider.listOpenPullRequests(kbRepo)).map((p: OpenPullRequest) => p.sourceBranch),
  );
  let settled = 0;
  // A dispute PR closed without merging retires its rule.
  const retiring: DecisionRecord[] = [];
  const closed = [...decisions.values()].flatMap((d) =>
    d.decided.filter((r) => r.decision === "review" && r.pr && !open.has(r.pr)),
  );
  if (closed.length) {
    // Ask the host which review PRs were merged: a document has no id line to look for on main.
    const since = new Date(Math.min(...closed.map((r) => Date.parse(r.at))) - 86_400_000);
    const mergedPrs = await provider.listMergedPullRequests(kbRepo, since);
    const merged = new Set(mergedPrs.map((p) => p.sourceBranch));
    // The host's merge time (Bitbucket gives the last update) measures how long a review waited.
    const mergedAt = new Map(mergedPrs.map((p) => [p.sourceBranch, p.mergedAt]));
    for (const r of closed) {
      const onMain = onBase(r.path);
      // A reviewer can drop one lesson by deleting its file from the PR before merging.
      const landed = onMain !== undefined && (isDocPath(r.path) || onMain.includes(`id: ${r.id}`));
      if (r.pr && merged.has(r.pr)) {
        r.decision = landed ? "merged" : "declined";
        r.reason = landed ? "merged by a reviewer" : "removed from the review PR by a reviewer";
      } else {
        r.decision = "declined";
        r.reason = "closed by a reviewer";
        if (r.pr?.startsWith(DISPUTE_PREFIX)) retiring.push(r);
      }
      r.at = now.toISOString();
      r.settledAt = (r.pr && mergedAt.get(r.pr)) || now.toISOString();
      settled++;
    }
  }

  // Lessons still waiting in an open review PR: a new lesson that repeats one waits with it.
  git(
    root,
    "fetch",
    "--quiet",
    "origin",
    "+refs/heads/homeostat/review-*:refs/remotes/origin/homeostat/review-*",
  );
  const inReview = [...decisions.values()].flatMap((d) =>
    d.decided.flatMap((r) => {
      if (r.decision !== "review" || !r.pr || !open.has(r.pr)) return [];
      const entry = parseEntry(showRule(root, remote(r.pr), r.path) ?? "").entry;
      return entry ? [{ path: r.path, entry }] : [];
    }),
  );

  // The review comments behind them, rules and document sections alike, are not drafted again.
  const waitingUrls = [...decisions.values()].flatMap((d) =>
    d.decided.flatMap((r) => {
      if (r.decision !== "review" || !r.pr || !open.has(r.pr)) return [];
      if (isDocPath(r.path)) {
        const doc = parseDoc(showFile(root, remote(r.pr), r.path) ?? "").doc;
        return doc?.sections.flatMap((s) => s.provenance?.url ?? []) ?? [];
      }
      return [];
    }),
  );
  // Rules: read from their review branches above.
  for (const { entry } of inReview)
    if (entry.frontmatter.source.url) waitingUrls.push(entry.frontmatter.source.url);

  const lessons: Lesson[] = [];
  const decidedHashes = (m: string) => new Set(decisions.get(m)?.decided.map((r) => r.hash));
  const heartbeats: Record<string, string> = {};

  // 1a. Pending lessons, from each developer's candidates branch.
  for (const m of members) {
    const branch = candidatesBranch(m);
    const ref = remote(branch);
    if (git(root, "rev-parse", "--verify", "--quiet", ref) === undefined) continue;
    const hb = git(root, "show", `${ref}:${HEARTBEAT_PATH}`);
    if (hb) heartbeats[m] = hb;
    const changed = (
      git(
        root,
        "diff",
        "--name-status",
        "--no-renames",
        `${remote(base)}...${ref}`,
        "--",
        "knowledge",
      ) ?? ""
    )
      .split("\n")
      .filter(Boolean);
    const seen = decidedHashes(m);
    for (const line of changed) {
      const [status, path = ""] = line.split("\t");
      if (status !== "A" && status !== "M") continue;
      const text = showFile(root, ref, path) ?? "";
      const hash = lessonHash(text);
      if (seen.has(hash)) continue;
      // A pending flag on a rule in a topic file arrives as a new one-rule file; the base has it.
      lessons.push(pendingLesson(m, path, text, hash, onBase(path)));
    }
  }

  // 1b. Lessons from review comments, filed under the developer whose PR it was.
  let drafted: CuratedEntry[] = [];
  let skipped: { url: string; reason: string }[] = [];
  if (!opts.noReviews) {
    const since = opts.since
      ? new Date(opts.since)
      : new Date(now.getTime() - config.agents.curator.lookbackHours * 3_600_000);
    const asker = askerFor(config, "curator", io, root, stats);
    const result = await curate({
      files,
      provider,
      drafter: io.drafter ?? new ClaudeDrafter(asker),
      patcher: io.patcher ?? new ClaudeDocPatcher(asker),
      since,
      today,
      waiting: waitingUrls,
    });
    drafted = result.entries;
    skipped = result.skipped.map((s) => ({ url: s.url, reason: s.reason }));
    for (const e of drafted) {
      const member = e.prAuthor ?? e.frontmatter.source.author;
      if (decidedHashes(member).has(lessonHash(e.text))) continue;
      lessons.push({
        member,
        path: e.path,
        text: accepted(e.text),
        hash: lessonHash(e.text),
        id: e.frontmatter.id,
        title: e.frontmatter.title,
        kind: "new",
        origin: "review",
        originator: e.frontmatter.source.author,
        ...(e.frontmatter.source.url ? { url: e.frontmatter.source.url } : {}),
        ...(e.suggestedTopic ? { suggestedTopic: e.suggestedTopic } : {}),
        decision: "review",
        reason: "",
      });
    }
    for (const d of result.docs) {
      lessons.push({
        member: d.sections[0]?.prAuthor ?? members[0] ?? "",
        path: d.path,
        text: d.text,
        hash: lessonHash(d.text),
        id: d.path,
        title: `Update ${d.sections.map((s) => `#${s.id}`).join(", ")} in ${d.path}`,
        kind: "doc",
        origin: "review",
        originator: d.sections[0]?.prAuthor ?? "",
        ...(d.sections[0]?.url ? { url: d.sections[0].url } : {}),
        decision: "review",
        reason: "document edits go to the owning team",
      });
    }
  }

  // A developer's pending edit and a review-drafted patch to the same document become one change:
  // merged three ways against the base branch, or the developer's edit alone if they conflict.
  for (const doc of lessons.filter((l) => l.kind === "doc" && l.origin === "review")) {
    const mine = lessons.find(
      (l) => l !== doc && l.kind === "doc" && l.path === doc.path && l.member === doc.member,
    );
    if (!mine) continue;
    // Each side stamps the document's `updated:` line with its own day; take the later one, or
    // that single line would make every pair of edits from different days conflict.
    const day = (t: string) => /^updated: (.*)$/m.exec(t)?.[1] ?? "";
    const latest = [day(mine.text), day(doc.text)].sort().at(-1) ?? "";
    const stamp = (t: string) => (latest ? t.replace(/^updated: .*$/m, `updated: ${latest}`) : t);
    const merged = mergeText(onBase(doc.path) ?? "", stamp(mine.text), stamp(doc.text));
    lessons.splice(lessons.indexOf(doc), 1);
    if (merged === undefined) {
      mine.reason = `document edits go to the owning team; a section patch from review (${doc.url ?? "a review thread"}) touched the same lines and was left out`;
    } else {
      mine.text = merged;
      mine.reason = "document edits go to the owning team; includes a section patch from review";
    }
  }

  // 2. Decide each lesson.
  // Lessons are compared within their repo, or with shared rules; never across two repos.
  const inForce = kb.entries.filter((e) => e.entry.frontmatter.status === "accepted");
  const near = (a: string, b: string) => comparable(a, b, config);
  // New lessons that teach the same thing, from anyone in this run, are decided together.
  const fresh = lessons.flatMap((l) => {
    const entry = l.kind === "new" ? parseEntry(l.text).entry : undefined;
    return entry ? [{ l, entry }] : [];
  });
  const groups = new Map<Lesson, Lesson[]>();
  for (const a of fresh) {
    groups.set(
      a.l,
      fresh
        .filter((b) => b === a || (near(a.l.path, b.l.path) && sameLesson(a.entry, b.entry)))
        .map((b) => b.l),
    );
  }
  for (const l of lessons) {
    const peers = inForce.filter((e) => near(e.path, l.path)).map((e) => e.entry);
    decide(l, files, config, peers, groups.get(l)?.length ?? 1);
  }
  for (const { l, entry } of fresh) {
    const twin = inReview.find(
      (r) =>
        r.entry.frontmatter.id === entry.frontmatter.id ||
        (near(r.path, l.path) && sameLesson(r.entry, entry)),
    )?.entry;
    if (!twin || l.decision === "declined") continue;
    l.decision = "review";
    l.reason = `the same lesson as ${twin.frontmatter.id}, which is waiting in review: decide them together`;
  }
  // If any copy of a lesson repeats a rule already in force, every copy reconfirms that rule.
  for (const [l, group] of groups) {
    const existing = group.find((x) => x.duplicateOf)?.duplicateOf;
    if (!existing || l.duplicateOf || l.decision === "declined") continue;
    l.decision = "declined";
    l.reason = `the same lesson as ${existing}, already in force, which it reconfirms`;
    l.duplicateOf = existing;
  }
  for (const [l, group] of groups) {
    if (group.length < 2) continue;
    const winner = group.reduce((best, x) =>
      (x.confidence?.score ?? -1) > (best.confidence?.score ?? -1) ? x : best,
    );
    if (winner === l || l.decision === "declined") continue;
    l.decision = "declined";
    l.reason = `the same lesson as ${winner.id} in this run, which carries it (${winner.decision})`;
  }

  // Flags on one rule from several developers go in as one change, or the second PR conflicts.
  const flagged = new Map<string, Lesson[]>();
  for (const l of lessons.filter((x) => x.kind === "flag")) {
    flagged.set(l.path, [...(flagged.get(l.path) ?? []), l]);
  }
  for (const [path, [first, ...rest]] of flagged) {
    if (!first || rest.length === 0) continue;
    let text = onBase(path);
    const seen = new Set(
      (parseEntry(text ?? "").entry?.frontmatter.flags ?? []).map((f) => JSON.stringify(f)),
    );
    for (const l of [first, ...rest]) {
      for (const f of parseEntry(l.text).entry?.frontmatter.flags ?? []) {
        const entry = parseEntry(text ?? "").entry;
        if (!entry || seen.has(JSON.stringify(f))) continue;
        seen.add(JSON.stringify(f));
        text = flagEntry(entry, f, config);
      }
    }
    if (!text) continue;
    first.text = text.replace(/^status: accepted$/m, "status: disputed");
    for (const l of rest) {
      l.carriedBy = first.member;
      l.reason = `${l.reason}; carried by ${first.member}'s daily PR with the other flags`;
    }
  }

  // Disputed rules: one review PR each, proposing a fix drafted from the flags, or retirement.
  // Merging applies it; closing retires the rule (next run, through the daily PR).
  const ownerOf = (e: Entry) => {
    const by = e.frontmatter.flags?.[0]?.by;
    return by && members.includes(by) ? by : (members[0] ?? "");
  };
  for (const r of retiring) {
    const entry = parseEntry(onBase(r.path) ?? "").entry;
    if (!entry || entry.frontmatter.status !== "disputed") continue;
    const text = resolveDispute(entry, null, today, config);
    lessons.push({
      member: ownerOf(entry),
      path: r.path,
      text,
      hash: lessonHash(text),
      id: entry.frontmatter.id,
      title: entry.frontmatter.title,
      kind: "retire",
      origin: "pending",
      originator: ownerOf(entry),
      decision: "merged",
      reason: "retired: a reviewer closed its dispute PR",
    });
  }
  // --no-reviews runs without the model: a dispute PR then proposes retiring the rule.
  const fixer =
    io.fixer ??
    (opts.noReviews
      ? { fix: async () => null }
      : new ClaudeRuleFixer(askerFor(config, "curator", io, root, stats)));
  for (const { path, entry } of kb.entries) {
    const id = entry.frontmatter.id;
    if (entry.frontmatter.status !== "disputed") continue;
    if (lessons.some((l) => l.kind === "retire" && l.id === id)) continue;
    if ([...open].some((b) => b.startsWith(`${DISPUTE_PREFIX}${id}-`))) continue;
    let fixed = await fixer.fix(entry);
    const problems = fixed ? fixProblems(fixed) : [];
    if (problems.length) {
      io.stdout(`  the drafted fix for ${id} was unusable (${problems.join("; ")})\n`);
      fixed = null;
    }
    lessons.push({
      member: ownerOf(entry),
      path,
      text: resolveDispute(entry, fixed, today, config),
      hash: lessonHash(onBase(path) ?? ""),
      id,
      title: entry.frontmatter.title,
      kind: "dispute",
      origin: "pending",
      originator: ownerOf(entry),
      decision: "review",
      reason: fixed
        ? "flagged as wrong; the PR proposes a fix (close it to retire the rule)"
        : "flagged as wrong; the PR proposes retiring it",
    });
  }

  // 3–4. Per developer: one daily PR (merged), one review PR (assigned).
  const report: RunReport = {
    at: now.toISOString(),
    members: [],
    settled,
    lessons: [],
    ...(skipped.length ? { skipped } : {}),
  };
  if (skipped.length) {
    io.stdout(
      `reviews read with no lesson:\n${skipped.map((s) => `  ${s.url}: ${s.reason}\n`).join("")}`,
    );
  }
  const byMember = new Map<string, Lesson[]>();
  for (const l of lessons) byMember.set(l.member, [...(byMember.get(l.member) ?? []), l]);
  const later: (() => Promise<void>)[] = [];
  for (const [member, list] of byMember) {
    const merged = list.filter((l) => l.decision === "merged");
    const review = list.filter((l) => l.decision === "review" && l.kind !== "dispute");
    const disputes = list.filter((l) => l.kind === "dispute");
    const declined = list.filter((l) => l.decision === "declined");
    const row: RunReport["members"][number] = {
      member,
      merged: merged.length,
      declined: declined.length,
      review: review.length,
    };
    report.members.push(row);
    // One at a time: the host refuses the whole request if any login can't review (the PR's own
    // author, or someone who isn't a collaborator), and the others should still be asked.
    const askReviewers = async (pr: { id: number; url: string }, logins: string[]) => {
      if (!logins.length || !provider.requestReviewers) return;
      const asked: string[] = [];
      const refused: string[] = [];
      for (const login of logins) {
        try {
          await provider.requestReviewers(kbRepo, pr.id, [login]);
          asked.push(`@${login}`);
        } catch (e) {
          refused.push(`@${login} (${(e as Error).message.replace(/^.*: /, "")})`);
        }
      }
      if (asked.length) io.stdout(`  asked ${asked.join(", ")} to review ${pr.url}\n`);
      if (refused.length) {
        row.reviewError = `could not request ${refused.join(", ")}`;
        io.stdout(
          `  ${row.reviewError}; reviewers must have access to ${sources.kbRepo}, and not be the PR's author\n`,
        );
      }
    };
    io.stdout(
      `${member}: ${merged.length} merged, ${review.length} to review, ${declined.length} declined\n`,
    );
    for (const l of list) io.stdout(`  ${l.decision.padEnd(8)} ${l.id}: ${l.reason}\n`);
    if (opts.dryRun) continue;

    const reconfirm = declined
      .flatMap((l) =>
        l.duplicateOf ? [reconfirmChange(files, kb.entries, l.duplicateOf, today)] : [],
      )
      .filter((c): c is FileChange => c !== undefined);
    const changes = [
      ...merged.filter((l) => !l.carriedBy).map((l) => change(l, "merge")),
      ...reconfirm,
    ];
    if (changes.length) {
      const pr = await publish({
        root,
        branch: `homeostat/daily-${member}-${today}`,
        changes: onFreshBase(changes),
        provider,
        kbRepo,
        base,
        title: `homeostat: daily lessons · ${member} · ${today}`,
        body: prBody(member, today, list, "daily"),
        io,
        // Merged at once: a pipeline on the branch would find it already deleted.
        skipCi: true,
      });
      if (pr.pr) {
        row.dailyPr = pr.pr.url;
        try {
          await provider.mergePullRequest(kbRepo, pr.pr.id, {
            message: `homeostat: daily lessons · ${member} · ${today}`,
          });
          io.stdout(`  merged ${pr.pr.url}\n`);
        } catch (e) {
          // Branch protection or a failing check: the confident lessons wait for a person instead.
          // The branch was pushed with [skip ci]; an ordinary commit lets a required build run.
          const tip = git(root, "rev-parse", `refs/heads/${pr.branch}`);
          if (tip) nudgeBranch(root, pr.branch, tip);
          row.mergeError = (e as Error).message;
          for (const l of merged) {
            l.decision = "review";
            l.reason = `${l.reason}; the host refused the merge`;
          }
          io.stdout(
            `  could not merge ${pr.pr.url}: ${row.mergeError}; it stays open for a reviewer\n`,
          );
        }
      }
      for (const l of merged) if (row.dailyPr) Object.assign(l, { pr: pr.branch });
    }
    // Review and dispute PRs open after every developer's daily PR has merged, on the base that
    // includes them: opened earlier, a PR sharing a topic file conflicts as soon as it opens.
    later.push(async () => {
      if (review.length) {
        const pr = await publish({
          root,
          branch: `homeostat/review-${member}-${today}`,
          changes: onFreshBase(review.map((l) => change(l, "review"))),
          provider,
          kbRepo,
          base,
          title: `homeostat: ${plural(review.length, "lesson")} to review · ${member} · ${today}`,
          body: prBody(member, today, list, "review"),
          io,
        });
        if (pr.pr) {
          row.reviewPr = pr.pr.url;
          await askReviewers(pr.pr, reviewerLogins(config, review, member));
        }
        for (const l of review) Object.assign(l, { pr: pr.branch });
      }
      for (const l of disputes) {
        const flags = parseEntry(onBase(l.path) ?? "").entry?.frontmatter.flags ?? [];
        const pr = await publish({
          root,
          branch: `${DISPUTE_PREFIX}${l.id}-${today}`,
          changes: onFreshBase([change(l, "review")]),
          provider,
          kbRepo,
          base,
          title: `homeostat: fix or retire ${l.id}`,
          body: disputeBody(l, flags),
          io,
        });
        if (pr.pr) {
          row.disputePrs = [...(row.disputePrs ?? []), pr.pr.url];
          io.stdout(`  opened ${pr.pr.url} for the disputed ${l.id}\n`);
          await askReviewers(pr.pr, reviewerLogins(config, [l], member));
        }
        Object.assign(l, { pr: pr.branch });
      }
    });
  }
  for (const open of later) await open();

  // 5. Record decisions, heartbeats and the report for the laptops and the dashboard.
  for (const l of lessons) {
    const parsed = l.kind === "doc" ? undefined : parseEntry(l.text).entry;
    const rule = parsed?.sections.rule;
    const source = l.kind === "doc" ? "doc" : parsed?.frontmatter.source.type;
    report.lessons.push({
      member: l.member,
      id: l.id,
      title: l.title,
      ...(rule ? { rule: excerpt(rule) } : {}),
      ...(l.url ? { url: l.url } : {}),
      decision: l.decision,
      ...(l.confidence ? { confidence: l.confidence.score } : {}),
      reason: l.reason,
      ...(source ? { source } : {}),
      origin: l.origin,
      ...(l.duplicateOf ? { duplicateOf: l.duplicateOf } : {}),
    });
    const record: DecisionRecord = {
      path: l.path,
      id: l.id,
      hash: l.hash,
      decision: l.decision,
      reason: l.reason,
      ...(l.confidence ? { confidence: l.confidence.score } : {}),
      ...((l as { pr?: string }).pr ? { pr: (l as { pr?: string }).pr } : {}),
      at: now.toISOString(),
      openedAt: now.toISOString(),
    };
    const d = decisions.get(l.member) ?? { member: l.member, decided: [] };
    d.decided = [...d.decided.filter((r) => r.hash !== l.hash), record].slice(-500);
    decisions.set(l.member, d);
  }
  // The run's own cost, and the KB's health after its merges, for the trend over runs.
  git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:${remote(base)}`);
  report.kb = kbSnapshot(
    validate(refFiles(root, remote(base))).entries.map((e) => e.entry),
    config,
    now,
  );
  report.timing = {
    started: now.toISOString(),
    finished: (io.now?.() ?? new Date()).toISOString(),
    modelCalls: stats.calls,
    chars: stats.chars,
    failedCalls: stats.failed,
  };
  if (!opts.dryRun) {
    const state: Record<string, string> = {
      // One file per run (a day can have several: the schedule, a manual run, a rerun).
      [`runs/${runName(now)}.json`]: `${JSON.stringify(report, null, 1)}\n`,
    };
    for (const [m, d] of decisions)
      if (d.decided.length) state[decisionsPath(m)] = `${JSON.stringify(d, null, 1)}\n`;
    for (const [m, hb] of Object.entries(heartbeats)) state[`heartbeats/${m}.json`] = `${hb}\n`;
    const parent = git(root, "rev-parse", "--verify", "--quiet", remote(STATE_BRANCH));
    const commit = commitTree(root, parent, state, `homeostat: daily run ${today}`);
    forcePush(root, commit, STATE_BRANCH);
    await notifyReviewQueue(config, report, [...decisions.values()], now, io);
  }

  logEvent(root, {
    ts: now.toISOString(),
    type: "agent-run",
    agent: "daily",
    ok: true,
    summary: `${report.members.reduce((n, m) => n + m.merged, 0)} merged, ${report.members.reduce((n, m) => n + m.review, 0)} to review, ${report.members.reduce((n, m) => n + m.declined, 0)} declined, ${settled} settled`,
  });
  if (lessons.length === 0) io.stdout("no new lessons\n");
  if (opts.dryRun) io.stdout("dry run: nothing committed, opened or merged\n");
  return 0;
}

/** Review PRs for disputed rules: one per rule, named so `homeostat review` and settling find them. */
const DISPUTE_PREFIX = "homeostat/review-dispute-";

function disputeBody(l: Lesson, flags: { by: string; reason: string; date: string }[]): string {
  const retire = /status: retired/.test(l.text);
  return [
    `\`${l.id}\` was flagged as wrong, so sessions stopped getting it.`,
    "",
    ...flags.map((f) => `- ${f.by} (${f.date}): ${f.reason}`),
    "",
    retire
      ? "This PR retires it: no fix could be drafted from the flags. Merge to retire it, or edit the rule here and set `status: accepted` to keep a corrected version."
      : "This PR proposes a corrected rule, drafted from the flags. Merge to put it back in force (edit it here first if needed); close the PR to retire the rule.",
    "",
    "Decided through `homeostat daily`; the next run records the outcome.",
  ].join("\n");
}

/** The start of a rule, for the run report: enough to tell lessons apart. */
const excerpt = (text: string, max = 240) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** `2026-10-17T10-26-28Z`: sortable, and safe in a file name. */
export const runName = (at: Date) => `${at.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;

function pendingLesson(
  member: string,
  path: string,
  text: string,
  hash: string,
  before: string | undefined,
): Lesson {
  const doc = isDocPath(path);
  const fm = doc ? undefined : parseEntry(text).entry?.frontmatter;
  const id = fm?.id ?? path;
  const flagOnly =
    !!fm &&
    before !== undefined &&
    (parseEntry(before).entry?.frontmatter.flags?.length ?? 0) < (fm.flags?.length ?? 0);
  return {
    member,
    path,
    text: doc ? text : accepted(text),
    hash,
    id,
    title: fm?.title ?? path,
    kind: doc ? "doc" : before === undefined ? "new" : flagOnly ? "flag" : "update",
    origin: "pending",
    originator: fm?.source.author ?? member,
    decision: "review",
    reason: "",
  };
}

function decide(
  l: Lesson,
  files: Record<string, string>,
  config: Config,
  inForce: Entry[],
  occurrences: number,
) {
  if (l.kind === "doc") {
    l.decision = "review";
    l.reason ||= "document edits go to the owning team";
    return;
  }
  if (l.kind === "flag") {
    // A flag needs no approval: it disputes the rule, which takes it out of sessions, until a
    // reviewer resolves it. Making it wait would keep a wrong rule in force.
    l.decision = "merged";
    l.reason = "a flag disputes the rule at once; a reviewer resolves it";
    l.text = l.text.replace(/^status: accepted$/m, "status: disputed");
    return;
  }
  const entry = parseEntry(l.text).entry as Entry | undefined;
  // An update or flag to a rule in a topic file replaces its section, not adds a second copy.
  const issues = validate(overlayPending(files, { [l.path]: l.text })).issues.filter(
    (i) => i.file === l.path && i.severity === "error",
  );
  if (!entry) {
    l.decision = "declined";
    l.reason = `does not parse: ${issues[0]?.message ?? "invalid entry"}`;
    return;
  }
  const fm = entry.frontmatter;
  const dupOf =
    l.kind === "new"
      ? inForce.find((x) => x.frontmatter.id !== fm.id && sameLesson(x, entry))?.frontmatter.id
      : undefined;
  const c = confidence({
    entry,
    config,
    originator: l.originator,
    occurrences,
    risks: issues.filter((i) => i.code.startsWith("risk.")).map((i) => i.message),
    errors: issues.filter((i) => !i.code.startsWith("risk.")).map((i) => i.message),
    ...(dupOf ? { duplicateOf: dupOf } : {}),
    ...(fm.conflictsWith?.length ? { conflictsWith: fm.conflictsWith } : {}),
  });
  l.confidence = c;
  l.decision = c.decision;
  l.reason = c.reason;
  if (dupOf) l.duplicateOf = dupOf;
}

const change = (l: Lesson, kind: "merge" | "review"): FileChange => ({
  path: l.path,
  text: l.text,
  message: `homeostat: ${kind === "merge" ? "merge" : "propose"} ${l.id} (${l.reason})`,
});

/** A duplicate reconfirms the rule it repeats: its lastConfirmed moves to today. */
function reconfirmChange(
  files: Record<string, string>,
  entries: { path: string; entry: Entry }[],
  id: string,
  today: string,
): FileChange | undefined {
  const found = entries.find((e) => e.entry.frontmatter.id === id);
  // In a topic file the rule has no file of its own; its section's one-rule text stands in.
  const text = found ? findRule(files, found.path) : undefined;
  if (!found || !text) return undefined;
  return {
    path: found.path,
    text: text.replace(/^lastConfirmed: .*$/m, `lastConfirmed: ${today}`),
    message: `homeostat: reconfirm ${id} (a lesson repeated it)`,
  };
}

function reviewerLogins(config: Config, review: Lesson[], member: string): string[] {
  const handles = new Set<string>();
  const named = config.team.reviewers ?? [];
  for (const id of named) {
    const h = config.team.members.find((m) => m.id === id)?.handle;
    if (h?.startsWith("@") && !h.includes("/")) handles.add(h.slice(1));
  }
  for (const l of named.length ? [] : review) {
    const area = parseEntry(l.text).entry?.frontmatter.area ?? "core";
    const team = Object.values(config.teams).find((t) => t.areas.includes(area));
    const owners = team
      ? team.handle
        ? [team.handle]
        : team.members.map((id) => config.team.members.find((m) => m.id === id)?.handle)
      : config.team.members
          .filter((m) => m.areas.includes(area) && m.id !== member)
          .map((m) => m.handle);
    const fallback = config.team.members
      .filter((m) => m.role === "lead" || m.role === "senior")
      .map((m) => m.handle);
    for (const h of owners.length ? owners : fallback)
      if (h?.startsWith("@") && !h.includes("/")) handles.add(h.slice(1));
  }
  const self = config.team.members.find((m) => m.id === member)?.handle;
  return [...handles].filter((h) => !self || loginKey(h) !== loginKey(self));
}

/** Lessons filed under general with a suggested topic: a note to add it to homeostat.yaml. */
function topicSuggestions(list: Lesson[]): string[] {
  const by = new Map<string, string[]>();
  for (const l of list) {
    if (l.suggestedTopic && l.decision !== "declined") {
      by.set(l.suggestedTopic, [...(by.get(l.suggestedTopic) ?? []), l.id]);
    }
  }
  if (by.size === 0) return [];
  return [
    "",
    "No topic fitted these, so they went to `general`. Add the suggested topic to homeostat.yaml if it is worth one; the deep dive then moves them:",
    ...[...by].map(([topic, ids]) => `- \`${topic}\`: ${ids.map((id) => `\`${id}\``).join(", ")}`),
  ];
}

function prBody(member: string, today: string, list: Lesson[], kind: "daily" | "review"): string {
  const rows = list.map((l) => {
    const why = l.confidence ? `${l.reason}<br>${explainConfidence(l.confidence)}` : l.reason;
    const src = l.url ? `[review](${l.url})` : l.origin === "pending" ? "written by hand" : "";
    return `| ${l.decision} | ${l.title} (\`${l.id}\`) | ${l.confidence?.score ?? ""} | ${src} | ${why} |`;
  });
  return [
    kind === "daily"
      ? `Daily lessons for ${member}, ${today}. The lessons marked merged passed every check and the confidence threshold, so this PR merges itself. Declined lessons are listed for the record; lessons to review are in a separate PR.`
      : `Lessons for ${member}, ${today}, that the daily run could not decide. Merge to accept them, close to decline, or edit first. The developer's sync picks up the outcome.`,
    "",
    "| Decision | Lesson | Confidence | Source | Why |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    ...topicSuggestions(list),
    "",
    "Decided by `homeostat daily`. Thresholds and weights are in `scoring.confidence` in homeostat.yaml; `homeostat flag <id>` sends any rule back for review.",
  ].join("\n");
}

/** The morning notice: today's review PRs, and a reminder for lessons waiting longer. */
async function notifyReviewQueue(
  config: Config,
  report: RunReport,
  decisions: DecisionsFile[],
  now: Date,
  io: Io,
) {
  const variable = config.notifications.slackWebhookEnv;
  const url = variable ? io.env?.[variable] : undefined;
  const waiting = report.members.filter((m) => m.review > 0 && m.reviewPr);
  const disputes = report.members.flatMap((m) => m.disputePrs ?? []);
  const refused = report.members.filter((m) => m.mergeError && m.dailyPr);
  const cutoff = new Date(now.getTime() - REVIEW_REMINDER_DAYS * 86_400_000).toISOString();
  const overdue = decisions.flatMap((d) =>
    d.decided
      .filter((r) => r.decision === "review" && r.at < cutoff)
      .map((r) => ({ member: d.member, ...r })),
  );
  if (!url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  if (!waiting.length && !overdue.length && !disputes.length && !refused.length) return;
  // Mention the named reviewers, so Slack notifies them wherever the webhook posts.
  const mentions = (config.team.reviewers ?? [])
    .map((id) => config.team.members.find((m) => m.id === id)?.slack)
    .filter((s): s is string => Boolean(s))
    .map((s) => `<@${s}>`);
  const lines = [
    ...(waiting.length
      ? [
          `*Homeostat: ${plural(
            waiting.reduce((n, m) => n + m.review, 0),
            "lesson",
          )} waiting for review*`,
          ...waiting.map((m) => `• ${m.member}: ${m.review} — ${m.reviewPr}`),
        ]
      : []),
    ...(disputes.length
      ? [`*Rules flagged as wrong: fix or retire*`, ...disputes.map((u) => `• ${u}`)]
      : []),
    ...(refused.length
      ? [
          `*Daily PRs the host refused to merge*`,
          ...refused.map((m) => `• ${m.member}: ${m.dailyPr}`),
        ]
      : []),
    ...(overdue.length
      ? [
          `*Still waiting after ${REVIEW_REMINDER_DAYS} days: ${plural(overdue.length, "lesson")}*`,
          ...overdue.map(
            (r) => `• ${r.id} (${r.member}, since ${r.at.slice(0, 10)}) — ${r.pr ?? ""}`,
          ),
        ]
      : []),
  ];
  if (mentions.length && lines[0]) lines[0] = `${mentions.join(" ")} ${lines[0]}`;
  const text = lines.join("\n");
  try {
    await (io.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, mrkdwn: true }),
    });
  } catch {
    // The dashboard shows the queue too; a failed notice must not fail the run.
  }
}
