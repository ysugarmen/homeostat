import { minimatch } from "minimatch";
import { CORE_AREA } from "../check.ts";
import type { Config } from "../config.ts";
import { isDocPath, parseDoc } from "../doc.ts";
import { applySectionPatch } from "../doc-patch.ts";
import { formatEntry } from "../entry.ts";
import { loginKey, memberForLogin } from "../handles.ts";
import type { Issue } from "../issues.ts";
import { areaMap, repoForSource, repoOf, ruleFilePath } from "../layout.ts";
import { SpendingCapError } from "../pricing.ts";
import type { Provider } from "../providers/types.ts";
import type { Frontmatter } from "../schema.ts";
import { score } from "../score.ts";
import { searchSections } from "../search.ts";
import { redactSecrets } from "../secrets.ts";
import { slugify } from "../slug.ts";
import { countTokens } from "../tokens.ts";
import { GENERAL_TOPIC, topicsFor } from "../topics.ts";
import { type KbFiles, validate } from "../validate.ts";
import type { DocCandidate, DocPatcher } from "./doc-patcher.ts";
import type { Draft, Drafter } from "./draft.ts";
import { type ReviewThread, reviewThreads } from "./threads.ts";
import { commentKey, commentKeyOf } from "./urls.ts";

export interface CurateInput {
  /** The KB as `validate()` takes it; its config must have `sources`. */
  files: KbFiles;
  provider: Provider;
  drafter: Drafter;
  /** Proposes document section edits from the same threads (K4); none when omitted. */
  patcher?: DocPatcher;
  since: Date;
  /** ISO date for `created` / `lastConfirmed`. */
  today: string;
  /**
   * Review-comment URLs behind lessons and document sections still waiting in open review PRs.
   * Their threads are skipped, so a lesson is not drafted again in other words while it waits.
   */
  waiting?: readonly string[];
}

export interface CuratedEntry {
  path: string;
  text: string;
  frontmatter: Frontmatter;
  /** The member whose pull request the review comment was on; the daily run files it under them. */
  prAuthor?: string;
  /**
   * Risky-content findings (see `risk.ts`). Such an entry stays a candidate and fails `validate`
   * until a member reads it and sets `riskReviewedBy`, so the PR shows it but cannot merge it.
   */
  risks: string[];
  /** Filed under general: the drafter's suggestion for a topic to add, for the PR body. */
  suggestedTopic?: string;
  /** The redacted thread it was drafted from, for the judge (see `judge.ts`). */
  thread?: ReviewThread;
}

/** A document changed by this run: one or more section patches, each from a review thread. */
export interface DocUpdate {
  path: string;
  text: string;
  sections: { id: string; reason: string; url: string; prAuthor?: string }[];
  /** Risky-content findings; such an update fails validate until a member signs it off. */
  risks: string[];
}

export interface Skipped {
  url: string;
  reason: string;
}

export interface CurateResult {
  entries: CuratedEntry[];
  skipped: Skipped[];
  /** Per repo: merged PRs and review threads looked at. */
  scanned: { repo: string; pullRequests: number; threads: number }[];
  /** Secrets removed from review threads before they were sent to a model. */
  redacted: number;
  docs: DocUpdate[];
  /**
   * Set when the run's spending cap stopped the drafting: the threads read but not drafted. Merged
   * PRs after them are not read; the next run reads them again.
   */
  capped?: { threads: number; error: SpendingCapError };
}

export class CurateError extends Error {}

/**
 * The daily curator, minus I/O: reads merged PRs since `since` in every configured repo, keeps
 * review threads followed by a code change that the KB does not already have, drafts one entry
 * per thread, scores it and validates it against the KB. Accepted when the score reaches the
 * auto-merge threshold, otherwise a candidate; a human merging the PR makes it final.
 */
export async function curate(input: CurateInput): Promise<CurateResult> {
  const kb = validate(input.files);
  const config = kb.config;
  if (!config)
    throw new CurateError("homeostat.yaml is missing or invalid; run homeostat validate");
  const sources = config.sources;
  if (!sources)
    throw new CurateError("homeostat.yaml has no sources section; the curator needs one");

  // A rule's own source, and the later lessons folded into it, are already in the KB.
  const known = new Set(
    kb.entries.flatMap(({ entry }) =>
      [entry.frontmatter.source.url, ...(entry.frontmatter.alsoFrom ?? [])].flatMap(
        (u) => commentKeyOf(u) ?? [],
      ),
    ),
  );
  const waiting = new Set((input.waiting ?? []).flatMap((u) => commentKeyOf(u) ?? []));
  const ids = new Set(kb.entries.map(({ entry }) => entry.frontmatter.id));
  const result: CurateResult = { entries: [], skipped: [], scanned: [], redacted: 0, docs: [] };
  // Threads already behind a document section count as known, like those behind entries.
  for (const { doc } of kb.docs) {
    for (const s of doc.sections) {
      const key = commentKeyOf(s.provenance?.url);
      if (key) known.add(key);
    }
  }
  let files = { ...input.files };
  let docChecks = 0;

  const excludedRepos = new Set(sources.exclude.repos.map((r) => r.toLowerCase()));
  const optedOut = new Set(
    config.team.members.filter((m) => m.optOut && m.handle).map((m) => loginKey(m.handle ?? "")),
  );
  const excludedPath = (path: string | undefined) =>
    path !== undefined && sources.exclude.paths.some((g) => minimatch(path, g, { dot: true }));

  for (const repoName of sources.repos) {
    if (excludedRepos.has(repoName.toLowerCase())) continue;
    // The KB repo's own pull requests are Homeostat's output: drafting from their review threads
    // would make rules and document sections cite the knowledge base as their own evidence.
    if (repoName.toLowerCase() === sources.kbRepo.toLowerCase()) {
      result.skipped.push({
        url: repoName,
        reason: "the knowledge base's own repo is never read as a code repo",
      });
      continue;
    }
    const [owner = "", name = ""] = repoName.split("/");
    const repo = { owner, name };
    // A multi-repo KB files each PR's lessons under its repo, with that repo's areas.
    const kbRepo = repoForSource(config, repoName);
    const areas = areaMap(config, kbRepo);
    const topics = topicsFor(config, kbRepo);
    const scanned = { repo: repoName, pullRequests: 0, threads: 0 };
    result.scanned.push(scanned);

    if (result.capped) break;
    for (const pr of await input.provider.listMergedPullRequests(repo, input.since)) {
      if (result.capped) break;
      scanned.pullRequests++;
      // Data controls (security plan T5): checked before anything is read or sent to a model.
      if (pr.skipRequested) {
        result.skipped.push({ url: pr.url, reason: "marked homeostat:skip" });
        continue;
      }
      if (optedOut.has(loginKey(pr.author.id))) {
        result.skipped.push({ url: pr.url, reason: "the author opted out" });
        continue;
      }
      let threads: ReturnType<typeof reviewThreads>;
      try {
        const [comments, commits] = await Promise.all([
          input.provider.listReviewComments(repo, pr.id),
          input.provider.listCommits(repo, pr.id),
        ]);
        threads = reviewThreads(repoName, pr, comments, commits);
      } catch (e) {
        result.skipped.push({
          url: pr.url,
          reason: `could not read the PR: ${(e as Error).message}`,
        });
        continue;
      }

      for (const thread of threads) {
        if (result.capped) {
          result.capped.threads++;
          continue;
        }
        scanned.threads++;
        const url = thread.root.url;
        const key = commentKey({
          host: sources.host,
          repo,
          pullRequest: pr.id,
          comment: thread.root.id,
        });
        const skip = (reason: string) => result.skipped.push({ url, reason });

        if (optedOut.has(loginKey(thread.root.author.id))) {
          skip("the reviewer opted out");
          continue;
        }
        if (excludedPath(thread.root.path)) {
          skip("the file is in sources.exclude.paths");
          continue;
        }
        if (known.has(key)) {
          skip("already in the knowledge base");
          continue;
        }
        if (waiting.has(key)) {
          skip("already waiting in a review PR");
          continue;
        }
        if (!thread.changedCode) {
          skip("no code change after the comment");
          continue;
        }
        const reviewer = memberForLogin(config.team.members, thread.root.author.id);
        if (!reviewer) {
          skip(`reviewer ${thread.root.author.id} has no member handle in homeostat.yaml`);
          continue;
        }

        const { thread: safe, redacted } = redactThread(thread);
        result.redacted += redacted;
        let draft: Draft | null;
        try {
          draft = await input.drafter.draft(safe, { areas, ...(topics ? { topics } : {}) });
          // Also a thread with no lasting rule can make a document wrong (a rename), so every
          // thread is checked, against a shortlist of sections and within a per-run cap.
          if (input.patcher && docChecks < config.agents.curator.docPatchCalls) {
            const asked = await docPatchStep(
              { files, config, result, today: input.today, repo: kbRepo },
              input.patcher,
              safe,
              url,
            );
            if (asked) docChecks++;
          }
        } catch (e) {
          if (!(e instanceof SpendingCapError)) throw e;
          // A lesson the cap cut off is left to the next run, which reads this thread again.
          result.capped = { threads: 1, error: e };
          continue;
        }
        if (!draft) {
          skip("no lasting rule in the thread");
          continue;
        }
        const check = (d: Draft) => {
          const area = d.area === CORE_AREA || areas[d.area] ? d.area : CORE_AREA;
          const built = buildEntry(config, {
            draft: { ...d, area },
            repo: kbRepo,
            id: uniqueId(slugify(d.title) ?? `review-${pr.id}-${thread.root.id}`, ids),
            url,
            author: reviewer.id,
            today: input.today,
          });
          const errs = validate({ ...files, [built.path]: built.text }).issues.filter(
            (i) => i.file === built.path && i.severity === "error",
          );
          return { built, errs };
        };
        const isRisk = (i: Issue) => i.code.startsWith("risk.");
        let { built: entry, errs: errors } = check(draft);
        let blocking = errors.filter((i) => !isRisk(i));
        // A draft over a length limit is worth one rewrite rather than losing the lesson.
        if (blocking.length > 0 && blocking.every(isLengthIssue)) {
          const problems = blocking.map((i) => i.message);
          let second: Draft | null;
          try {
            second = await input.drafter.draft(safe, {
              areas,
              ...(topics ? { topics } : {}),
              revise: { previous: draft, problems },
            });
          } catch (e) {
            if (!(e instanceof SpendingCapError)) throw e;
            result.capped = { threads: 1, error: e };
            continue;
          }
          if (second) {
            draft = second;
            ({ built: entry, errs: errors } = check(draft));
            blocking = errors.filter((i) => !isRisk(i));
          }
        }
        if (blocking.length > 0) {
          skip(`draft did not validate: ${blocking.map((i) => i.message).join("; ")}`);
          continue;
        }
        const risks = errors.filter(isRisk).map((i) => i.message);
        if (risks.length > 0) entry = asRiskyCandidate(entry, risks);
        files = { ...files, [entry.path]: entry.text };
        ids.add(entry.frontmatter.id);
        known.add(key);
        const prAuthor = memberForLogin(config.team.members, pr.author.id)?.id;
        result.entries.push({ ...entry, ...(prAuthor ? { prAuthor } : {}), thread: safe });
      }
    }
  }
  return result;
}

/** At most this many sections, and about this many tokens of them, go with one thread. */
const DOC_PATCH_SECTIONS = 3;
const DOC_PATCH_TOKENS = 3000;

/**
 * Asks the patcher about the document sections the thread could affect, and applies its proposal
 * as a one-section patch. Only sections of documents covering the thread's file, ranked by the
 * thread's own words and path, best three within a token cap: sending every covering document
 * cost ~70k tokens a thread on a KB whose documents cover everything. No matching section, no
 * call; the return says whether the model was asked. A proposal that names an unknown section or would break the document is
 * skipped; one with risky content is kept and marked, so the PR shows it but validate blocks it.
 */
async function docPatchStep(
  ctx: {
    files: KbFiles;
    config: Config;
    result: CurateResult;
    today: string;
    /** The PR's repo in a multi-repo KB: only shared documents and that repo's are patched. */
    repo?: string | undefined;
  },
  patcher: DocPatcher,
  thread: ReviewThread,
  url: string,
): Promise<boolean> {
  const path = thread.root.path;
  if (!path) return false;
  const current = (p: string) =>
    ctx.result.docs.find((d) => d.path === p)?.text ?? ctx.files[p] ?? "";
  const candidates: DocCandidate[] = [];
  for (const p of Object.keys(ctx.files)) {
    if (!isDocPath(p)) continue;
    const own = repoOf(p, ctx.config);
    if (own !== undefined && own !== ctx.repo) continue;
    const doc = parseDoc(current(p)).doc;
    if (!doc?.frontmatter.scope.some((g) => minimatch(path, g, { dot: true }))) continue;
    candidates.push({
      path: p,
      title: doc.frontmatter.title,
      sections: doc.sections
        .filter((s) => s.id)
        .map((s) => ({ id: s.id, heading: s.heading, body: s.body })),
    });
  }
  if (candidates.length === 0) return false;
  const query = [
    path.replace(/[/._-]+/g, " "),
    thread.pullRequest.title,
    thread.root.body,
    ...thread.replies.map((r) => r.body),
  ].join(" ");
  const hits = searchSections(
    candidates.flatMap((c) =>
      c.sections.map((s) => ({
        doc: c.path,
        title: c.title,
        id: s.id,
        heading: s.heading,
        body: s.body,
      })),
    ),
    query,
    { limit: DOC_PATCH_SECTIONS },
  );
  let tokens = 0;
  const picked = hits.filter(({ section: s }, i) => {
    tokens += countTokens(`${s.heading}\n${s.body}`);
    return i === 0 || tokens <= DOC_PATCH_TOKENS;
  });
  if (picked.length === 0) return false;
  const shortlist: DocCandidate[] = candidates.flatMap((c) => {
    const sections = c.sections.filter((s) =>
      picked.some((h) => h.section.doc === c.path && h.section.id === s.id),
    );
    return sections.length ? [{ ...c, sections }] : [];
  });
  const proposal = await patcher.propose(thread, shortlist);
  if (!proposal) return true;
  const skip = (reason: string) =>
    ctx.result.skipped.push({ url, reason: `document patch: ${reason}` });
  if (
    !candidates.some(
      (c) => c.path === proposal.path && c.sections.some((s) => s.id === proposal.sectionId),
    )
  ) {
    skip(`no section ${proposal.path}#${proposal.sectionId}`);
    return true;
  }
  let text: string;
  try {
    text = applySectionPatch(
      current(proposal.path),
      {
        op: proposal.op,
        id: proposal.sectionId,
        body: proposal.body,
        provenance: { source: "curator", url, updated: ctx.today },
      },
      ctx.today,
    );
  } catch (e) {
    skip((e as Error).message);
    return true;
  }
  const errors = validate({ ...ctx.files, [proposal.path]: text }).issues.filter(
    (i) => i.file === proposal.path && i.severity === "error",
  );
  if (errors.some((i) => !i.code.startsWith("risk."))) {
    skip(errors.map((i) => i.message).join("; "));
    return true;
  }
  const risks = errors.map((i) => i.message);
  const existing = ctx.result.docs.find((d) => d.path === proposal.path);
  const prAuthor = memberForLogin(ctx.config.team.members, thread.pullRequest.author.id)?.id;
  const section = {
    id: proposal.sectionId,
    reason: proposal.reason,
    url,
    ...(prAuthor ? { prAuthor } : {}),
  };
  if (existing) {
    existing.text = text;
    existing.sections.push(section);
    existing.risks.push(...risks);
  } else {
    ctx.result.docs.push({ path: proposal.path, text, sections: [section], risks });
  }
  return true;
}

/** Over a word or character limit: fixable by rewriting shorter. */
const isLengthIssue = (i: Issue) =>
  i.code.endsWith(".tooLong") || /at most \d+ characters/.test(i.message);

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 56)}-${n}`;
  return id;
}

function buildEntry(
  config: Config,
  args: {
    draft: {
      title: string;
      rule: string;
      why: string;
      area: string;
      topic?: string;
      suggestedTopic?: string;
    };
    /** The multi-repo KB's repo the PR is from; undefined in a one-repo KB. */
    repo?: string | undefined;
    id: string;
    url: string;
    author: string;
    today: string;
  },
): CuratedEntry {
  const { draft } = args;
  const body = `## Rule\n${draft.rule}\n\n## Why\n${draft.why}`;
  const frontmatter: Frontmatter = {
    id: args.id,
    title: draft.title,
    area: draft.area,
    scope: [...(areaMap(config, args.repo)[draft.area] ?? ["**"])],
    status: "candidate",
    score: 0,
    owner: args.author,
    source: { type: "pr-feedback", url: args.url, author: args.author, changedCode: true },
    created: args.today,
    lastConfirmed: args.today,
    tokens: countTokens(body),
  };
  // A topic KB: the drafter's topic if it is listed, else general (with its suggestion kept).
  const topics = topicsFor(config, args.repo);
  const topic = topics
    ? draft.topic && Object.hasOwn(topics, draft.topic)
      ? draft.topic
      : GENERAL_TOPIC
    : undefined;
  if (topic) frontmatter.topic = topic;
  const suggested =
    topic === GENERAL_TOPIC
      ? (draft.suggestedTopic ?? (draft.topic !== GENERAL_TOPIC ? draft.topic : undefined))
      : undefined;
  frontmatter.score = score(frontmatter, { config }).score;
  if (frontmatter.score >= config.scoring.autoMergeThreshold) frontmatter.status = "accepted";
  return {
    ...(suggested ? { suggestedTopic: suggested } : {}),
    path: ruleFilePath(config, { repo: args.repo, area: draft.area, id: args.id }),
    text: formatEntry(frontmatter, body),
    frontmatter,
    risks: [],
  };
}

/** A flagged draft never auto-merges: it is shown to reviewers as a candidate. */
function asRiskyCandidate(entry: CuratedEntry, risks: string[]): CuratedEntry {
  const frontmatter: Frontmatter = { ...entry.frontmatter, status: "candidate" };
  const body = entry.text.slice(entry.text.indexOf("## Rule"));
  return { ...entry, frontmatter, text: formatEntry(frontmatter, body), risks };
}

/** A copy of the thread with secrets in its text replaced, so they never reach a model. */
function redactThread(thread: ReviewThread): { thread: ReviewThread; redacted: number } {
  let redacted = 0;
  const clean = (s: string) => {
    const r = redactSecrets(s);
    redacted += r.findings.length;
    return r.text;
  };
  const comment = (c: ReviewThread["root"]) => ({ ...c, body: clean(c.body) });
  return {
    thread: {
      ...thread,
      pullRequest: { ...thread.pullRequest, title: clean(thread.pullRequest.title) },
      root: comment(thread.root),
      replies: thread.replies.map(comment),
    },
    redacted,
  };
}
