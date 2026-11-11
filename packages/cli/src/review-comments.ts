import {
  areaMap,
  type Config,
  countTokens,
  formatEntry,
  isSenior,
  locate,
  memberForLogin,
  type Provider,
  type RepoRef,
  type ReviewComment,
  type ReviewRewriter,
  repoNames,
  ruleFilePath,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { commitFile, git, pushBranch } from "./git.ts";
import { foldChanges, refFiles } from "./kb-write.ts";
import type { FileChange } from "./publish.ts";

/** Starts every reply the daily run posts, naming the comment it answers, so none is done twice. */
export const REPLY_MARK = "↻ Homeostat";
const answered = (body: string) =>
  [...body.matchAll(/↻ Homeostat \(comment (\d+)\)/g)].map((m) => Number(m[1]));

export interface CommentsContext {
  root: string;
  base: string;
  config: Config;
  provider: Provider;
  kbRepo: RepoRef;
  rewriter: ReviewRewriter;
  io: Io;
}

/**
 * Applies reviewers' comments on open one-lesson review PRs: a comment that asks to change the
 * rule (generalise it, rescope it, reword it, move it) is rewritten into the PR's branch, checked,
 * pushed, and answered on the PR; the reviewer then merges. Only reviewers' comments count (the
 * named reviewers, else seniors and leads), each once. Returns how many PRs changed.
 */
export async function applyReviewComments(ctx: CommentsContext): Promise<number> {
  const { root, base, config, provider, kbRepo, rewriter, io } = ctx;
  const deciders = new Set(
    config.team.reviewers ?? config.team.members.filter((m) => isSenior(m.role)).map((m) => m.id),
  );
  const open = (await provider.listOpenPullRequests(kbRepo)).filter(
    (p) =>
      p.targetBranch === base &&
      p.sourceBranch.startsWith("homeostat/review-") &&
      !p.sourceBranch.startsWith("homeostat/review-dispute-"),
  );
  let changed = 0;
  for (const pr of open) {
    let comments: ReviewComment[];
    try {
      comments = await provider.listReviewComments(kbRepo, pr.id);
    } catch {
      continue;
    }
    const done = new Set(comments.flatMap((c) => answered(c.body)));
    const byDecider = (c: ReviewComment) => {
      if (c.body.startsWith(REPLY_MARK)) return undefined;
      const m =
        memberForLogin(config.team.members, c.author.id) ??
        (c.author.name ? memberForLogin(config.team.members, c.author.name) : undefined);
      return m && deciders.has(m.id) ? m : undefined;
    };
    const todo = comments
      .filter((c) => !done.has(c.id) && byDecider(c))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!todo.length) continue;

    git(
      root,
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${pr.sourceBranch}:refs/remotes/origin/${pr.sourceBranch}`,
    );
    git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`);
    const prRef = `refs/remotes/origin/${pr.sourceBranch}`;
    const before = new Map(
      validate(refFiles(root, `refs/remotes/origin/${base}`), { checks: false }).entries.map(
        (e) => [e.entry.frontmatter.id, JSON.stringify(e.entry)],
      ),
    );
    const lessons = validate(refFiles(root, prRef), { checks: false }).entries.filter(
      (e) => before.get(e.entry.frontmatter.id) !== JSON.stringify(e.entry),
    );
    const [lesson] = lessons;
    if (lessons.length !== 1 || !lesson) {
      io.stdout(
        `  #${pr.id}: a reviewer's comment, but the PR holds ${lessons.length} rules; a person applies it\n`,
      );
      continue;
    }

    const repos = config.repos ? repoNames(config) : undefined;
    const repo = repos ? locate(lesson.path, repos)?.repo : undefined;
    const areas = { core: ["**"], ...areaMap(config, repo) };
    let entry = lesson.entry;
    const replies: string[] = [];
    let wrote = false;
    for (const c of todo) {
      const who = byDecider(c)?.id ?? c.author.id;
      const r = await rewriter.rewrite({
        comment: { author: who, body: c.body },
        earlier: comments
          .filter((e) => e.createdAt < c.createdAt && !e.body.startsWith(REPLY_MARK))
          .map((e) => ({ author: e.author.name ?? e.author.id, body: e.body })),
        rule: {
          title: entry.frontmatter.title,
          rule: entry.sections.rule ?? "",
          why: entry.sections.why ?? "",
          area: entry.frontmatter.area,
          scope: entry.frontmatter.scope,
        },
        areas,
      });
      if (!r) continue;
      if (!r.change || !r.rule) {
        replies.push(`${REPLY_MARK} (comment ${c.id}): no change to the rule. ${r.reply}`);
        continue;
      }
      const area = Object.hasOwn(areas, r.area) ? r.area : entry.frontmatter.area;
      const body = `## Rule\n${r.rule}\n\n## Why\n${r.why}`;
      const fm = {
        ...entry.frontmatter,
        title: r.title || entry.frontmatter.title,
        area,
        scope: r.scope.length ? r.scope : entry.frontmatter.scope,
        tokens: countTokens(body),
      };
      entry = {
        ...entry,
        frontmatter: fm,
        body,
        sections: { ...entry.sections, rule: r.rule, why: r.why },
      };
      wrote = true;
      replies.push(
        `${REPLY_MARK} (comment ${c.id}): ${r.reply} The rule now reads "${fm.title}", in ${area}, scope ${fm.scope.join(", ")}. Merge when it reads right.`,
      );
    }

    if (wrote) {
      const to = ruleFilePath(config, {
        repo,
        area: entry.frontmatter.area,
        id: entry.frontmatter.id,
      });
      const text = formatEntry(entry.frontmatter, entry.body);
      const changes: FileChange[] = [
        ...(to !== lesson.path ? [{ path: lesson.path, text: null, message: "x" }] : []),
        {
          path: to,
          text,
          message: `homeostat: rewrite ${entry.frontmatter.id} as a reviewer asked`,
        },
      ];
      git(root, "branch", "--force", pr.sourceBranch, prRef);
      for (const f of foldChanges(root, prRef, changes, config))
        commitFile(
          root,
          pr.sourceBranch,
          f.path,
          f.text,
          `homeostat: rewrite ${entry.frontmatter.id} as a reviewer asked`,
        );
      const issues = validate(refFiles(root, `refs/heads/${pr.sourceBranch}`)).issues.filter(
        (i) => i.severity === "error",
      );
      if (issues.length) {
        io.stdout(
          `  #${pr.id}: the rewrite does not validate (${issues[0]?.message}); left as it was\n`,
        );
        replies.splice(
          0,
          replies.length,
          `${REPLY_MARK} (comment ${todo.map((c) => c.id).join(", comment ")}): I could not apply this: the rewritten rule does not validate (${issues[0]?.message ?? "an error"}). Please edit it on the branch.`,
        );
      } else {
        pushBranch(root, pr.sourceBranch);
        changed++;
        io.stdout(
          `  #${pr.id}: rewrote ${entry.frontmatter.id} as ${todo.length === 1 ? "a reviewer" : "reviewers"} asked\n`,
        );
      }
    }
    for (const reply of replies) {
      try {
        await provider.commentOnPullRequest(kbRepo, pr.id, reply);
      } catch (e) {
        io.stdout(`  #${pr.id}: could not reply (${(e as Error).message})\n`);
      }
    }
  }
  return changed;
}
