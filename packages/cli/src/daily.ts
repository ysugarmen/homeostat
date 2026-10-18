import { resolve } from "node:path";
import {
  ClaudeDocPatcher,
  ClaudeDrafter,
  type Confidence,
  type Config,
  type CuratedEntry,
  candidatesBranch,
  confidence,
  curate,
  type DecisionRecord,
  type DecisionsFile,
  decisionsPath,
  type Entry,
  explainConfidence,
  flagEntry,
  HEARTBEAT_PATH,
  isDocPath,
  lessonHash,
  logEvent,
  type OpenPullRequest,
  parseEntry,
  REVIEW_REMINDER_DAYS,
  type RepoRef,
  type RunReport,
  readKbFiles,
  STATE_BRANCH,
  sameLesson,
  validate,
} from "@homeostat/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { plural } from "./format.ts";
import { commitTree, forcePush, git, mergeText, showFile } from "./git.ts";
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
  kind: "new" | "update" | "flag" | "doc";
  origin: "pending" | "review";
  originator: string;
  url?: string;
  decision: DecisionRecord["decision"];
  reason: string;
  confidence?: Confidence;
  duplicateOf?: string;
  /** Another developer's daily PR commits this change, combined with theirs. */
  carriedBy?: string;
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
  const onBase = (path: string) => showFile(root, remote(base), path);

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
  const closed = [...decisions.values()].flatMap((d) =>
    d.decided.filter((r) => r.decision === "review" && r.pr && !open.has(r.pr)),
  );
  if (closed.length) {
    // Ask the host which review PRs were merged: a document has no id line to look for on main.
    const since = new Date(Math.min(...closed.map((r) => Date.parse(r.at))) - 86_400_000);
    const merged = new Set(
      (await provider.listMergedPullRequests(kbRepo, since)).map((p) => p.sourceBranch),
    );
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
      }
      r.at = now.toISOString();
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
      const entry = parseEntry(showFile(root, remote(r.pr), r.path) ?? "").entry;
      return entry ? [entry] : [];
    }),
  );

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
      lessons.push(pendingLesson(m, path, text, hash, status === "A" ? undefined : onBase(path)));
    }
  }

  // 1b. Lessons from review comments, filed under the developer whose PR it was.
  let drafted: CuratedEntry[] = [];
  let skipped: { url: string; reason: string }[] = [];
  if (!opts.noReviews) {
    const since = opts.since
      ? new Date(opts.since)
      : new Date(now.getTime() - config.agents.curator.lookbackHours * 3_600_000);
    const asker = askerFor(config, "curator", io, root);
    const result = await curate({
      files,
      provider,
      drafter: io.drafter ?? new ClaudeDrafter(asker),
      patcher: io.patcher ?? new ClaudeDocPatcher(asker),
      since,
      today,
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
  const inForce = kb.entries
    .filter((e) => e.entry.frontmatter.status === "accepted")
    .map((e) => e.entry);
  // New lessons that teach the same thing, from anyone in this run, are decided together.
  const fresh = lessons.flatMap((l) => {
    const entry = l.kind === "new" ? parseEntry(l.text).entry : undefined;
    return entry ? [{ l, entry }] : [];
  });
  const groups = new Map<Lesson, Lesson[]>();
  for (const a of fresh) {
    groups.set(
      a.l,
      fresh.filter((b) => b === a || sameLesson(a.entry, b.entry)).map((b) => b.l),
    );
  }
  for (const l of lessons) decide(l, files, config, inForce, groups.get(l)?.length ?? 1);
  for (const { l, entry } of fresh) {
    const twin = inReview.find(
      (r) => r.frontmatter.id === entry.frontmatter.id || sameLesson(r, entry),
    );
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
  for (const [member, list] of byMember) {
    const merged = list.filter((l) => l.decision === "merged");
    const review = list.filter((l) => l.decision === "review");
    const declined = list.filter((l) => l.decision === "declined");
    const row: RunReport["members"][number] = {
      member,
      merged: merged.length,
      declined: declined.length,
      review: review.length,
    };
    report.members.push(row);
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
        changes,
        provider,
        kbRepo,
        base,
        title: `homeostat: daily lessons · ${member} · ${today}`,
        body: prBody(member, today, list, "daily"),
        io,
      });
      if (pr.pr) {
        row.dailyPr = pr.pr.url;
        try {
          await provider.mergePullRequest(kbRepo, pr.pr.id);
          io.stdout(`  merged ${pr.pr.url}\n`);
        } catch (e) {
          // Branch protection or a failing check: the confident lessons wait for a person instead.
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
    if (review.length) {
      const pr = await publish({
        root,
        branch: `homeostat/review-${member}-${today}`,
        changes: review.map((l) => change(l, "review")),
        provider,
        kbRepo,
        base,
        title: `homeostat: ${plural(review.length, "lesson")} to review · ${member} · ${today}`,
        body: prBody(member, today, list, "review"),
        io,
      });
      if (pr.pr) {
        row.reviewPr = pr.pr.url;
        const logins = reviewerLogins(config, review, member);
        if (logins.length && provider.requestReviewers) {
          // One at a time: the host refuses the whole request if any login can't review (the PR's
          // own author, or someone who isn't a collaborator), and the others should still be asked.
          const asked: string[] = [];
          const refused: string[] = [];
          for (const login of logins) {
            try {
              await provider.requestReviewers(kbRepo, pr.pr.id, [login]);
              asked.push(`@${login}`);
            } catch (e) {
              refused.push(`@${login} (${(e as Error).message.replace(/^.*: /, "")})`);
            }
          }
          if (asked.length) io.stdout(`  asked ${asked.join(", ")} to review ${pr.pr.url}\n`);
          if (refused.length) {
            row.reviewError = `could not request ${refused.join(", ")}`;
            io.stdout(
              `  ${row.reviewError}; reviewers must be collaborators on ${sources.kbRepo}, and not the PR's author\n`,
            );
          }
        }
      }
      for (const l of review) Object.assign(l, { pr: pr.branch });
    }
  }

  // 5. Record decisions, heartbeats and the report for the laptops and the dashboard.
  for (const l of lessons) {
    report.lessons.push({
      member: l.member,
      id: l.id,
      decision: l.decision,
      ...(l.confidence ? { confidence: l.confidence.score } : {}),
      reason: l.reason,
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
    };
    const d = decisions.get(l.member) ?? { member: l.member, decided: [] };
    d.decided = [...d.decided.filter((r) => r.hash !== l.hash), record].slice(-500);
    decisions.set(l.member, d);
  }
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
  const issues = validate({ ...files, [l.path]: l.text }).issues.filter(
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
  const text = found ? files[found.path] : undefined;
  if (!found || !text) return undefined;
  return {
    path: found.path,
    text: text.replace(/^lastConfirmed: .*$/m, `lastConfirmed: ${today}`),
    message: `homeostat: reconfirm ${id} (a lesson repeated it)`,
  };
}

function reviewerLogins(config: Config, review: Lesson[], member: string): string[] {
  const handles = new Set<string>();
  for (const l of review) {
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
  const self = config.team.members.find((m) => m.id === member)?.handle?.slice(1);
  return [...handles].filter((h) => h !== self);
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
  const cutoff = new Date(now.getTime() - REVIEW_REMINDER_DAYS * 86_400_000).toISOString();
  const overdue = decisions.flatMap((d) =>
    d.decided
      .filter((r) => r.decision === "review" && r.at < cutoff)
      .map((r) => ({ member: d.member, ...r })),
  );
  if (!url || !/^https:\/\/hooks\.slack\.com\//.test(url)) return;
  if (waiting.length === 0 && overdue.length === 0) return;
  const text = [
    ...(waiting.length
      ? [
          `*Homeostat: ${plural(
            waiting.reduce((n, m) => n + m.review, 0),
            "lesson",
          )} waiting for review*`,
          ...waiting.map((m) => `• ${m.member}: ${m.review} — ${m.reviewPr}`),
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
  ].join("\n");
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
