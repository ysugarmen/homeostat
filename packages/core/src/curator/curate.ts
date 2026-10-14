import { CORE_AREA } from "../check.ts";
import type { Config } from "../config.ts";
import { formatEntry } from "../entry.ts";
import type { Provider } from "../providers/types.ts";
import type { Frontmatter } from "../schema.ts";
import { score } from "../score.ts";
import { redactSecrets } from "../secrets.ts";
import { slugify } from "../slug.ts";
import { countTokens } from "../tokens.ts";
import { type KbFiles, validate } from "../validate.ts";
import type { Drafter } from "./draft.ts";
import { type ReviewThread, reviewThreads } from "./threads.ts";
import { commentKey, commentKeyOf } from "./urls.ts";

export interface CurateInput {
  /** The KB as `validate()` takes it; its config must have `sources`. */
  files: KbFiles;
  provider: Provider;
  drafter: Drafter;
  since: Date;
  /** ISO date for `created` / `lastConfirmed`. */
  today: string;
}

export interface CuratedEntry {
  path: string;
  text: string;
  frontmatter: Frontmatter;
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

  const known = new Set(
    kb.entries.flatMap(({ entry }) => commentKeyOf(entry.frontmatter.source.url) ?? []),
  );
  const ids = new Set(kb.entries.map(({ entry }) => entry.frontmatter.id));
  const result: CurateResult = { entries: [], skipped: [], scanned: [], redacted: 0 };
  let files = { ...input.files };

  for (const repoName of sources.repos) {
    const [owner = "", name = ""] = repoName.split("/");
    const repo = { owner, name };
    const scanned = { repo: repoName, pullRequests: 0, threads: 0 };
    result.scanned.push(scanned);

    for (const pr of await input.provider.listMergedPullRequests(repo, input.since)) {
      scanned.pullRequests++;
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
        scanned.threads++;
        const url = thread.root.url;
        const key = commentKey({
          host: sources.host,
          repo,
          pullRequest: pr.id,
          comment: thread.root.id,
        });
        const skip = (reason: string) => result.skipped.push({ url, reason });

        if (known.has(key)) {
          skip("already in the knowledge base");
          continue;
        }
        if (!thread.changedCode) {
          skip("no code change after the comment");
          continue;
        }
        const reviewer = config.team.members.find((m) => m.handle === `@${thread.root.author.id}`);
        if (!reviewer) {
          skip(`reviewer ${thread.root.author.id} has no member handle in homeostat.yaml`);
          continue;
        }

        const { thread: safe, redacted } = redactThread(thread);
        result.redacted += redacted;
        const draft = await input.drafter.draft(safe, { areas: config.areas });
        if (!draft) {
          skip("no lasting rule in the thread");
          continue;
        }
        const area = draft.area === CORE_AREA || config.areas[draft.area] ? draft.area : CORE_AREA;
        const entry = buildEntry(config, {
          draft: { ...draft, area },
          id: uniqueId(slugify(draft.title) ?? `review-${pr.id}-${thread.root.id}`, ids),
          url,
          author: reviewer.id,
          today: input.today,
        });

        const issues = validate({ ...files, [entry.path]: entry.text }).issues.filter(
          (i) => i.file === entry.path && i.severity === "error",
        );
        if (issues.length > 0) {
          skip(`draft did not validate: ${issues.map((i) => i.message).join("; ")}`);
          continue;
        }
        files = { ...files, [entry.path]: entry.text };
        ids.add(entry.frontmatter.id);
        known.add(key);
        result.entries.push(entry);
      }
    }
  }
  return result;
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 56)}-${n}`;
  return id;
}

function buildEntry(
  config: Config,
  args: {
    draft: { title: string; rule: string; why: string; area: string };
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
    scope: [...(config.areas[draft.area] ?? ["**"])],
    status: "candidate",
    score: 0,
    owner: args.author,
    source: { type: "pr-feedback", url: args.url, author: args.author, changedCode: true },
    created: args.today,
    lastConfirmed: args.today,
    tokens: countTokens(body),
  };
  frontmatter.score = score(frontmatter, { config }).score;
  if (frontmatter.score >= config.scoring.autoMergeThreshold) frontmatter.status = "accepted";
  return {
    path: `knowledge/${draft.area}/${args.id}.md`,
    text: formatEntry(frontmatter, body),
    frontmatter,
  };
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
