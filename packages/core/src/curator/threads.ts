import type { Commit, PullRequest, ReviewComment } from "../providers/types.ts";

/** Tokens a thread may send to a model; a longer one is cut, the opening comment first. */
export const THREAD_TOKENS = 1500;

export interface ReviewThread {
  /** `owner/name` of the code repo. */
  repo: string;
  pullRequest: PullRequest;
  /** The comment that opened the thread: the feedback itself. */
  root: ReviewComment;
  replies: ReviewComment[];
  /** A commit landed on the PR after the feedback: the accepted-feedback (+3) signal. */
  changedCode: boolean;
}

/**
 * Groups a PR's review comments into threads opened by someone other than the PR author, and
 * marks each with whether the code changed after it. Replies to replies attach to their root.
 */
export function reviewThreads(
  repo: string,
  pullRequest: PullRequest,
  comments: readonly ReviewComment[],
  commits: readonly Commit[],
): ReviewThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: ReviewComment): ReviewComment => {
    const seen = new Set<number>();
    let current = c;
    while (current.inReplyTo !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.inReplyTo);
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const threads = new Map<number, ReviewThread>();
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of sorted) {
    const root = rootOf(c);
    if (root.author.id === pullRequest.author.id || !root.body.trim()) continue;
    let thread = threads.get(root.id);
    if (!thread) {
      const at = Date.parse(root.createdAt);
      thread = {
        repo,
        pullRequest,
        root,
        replies: [],
        changedCode: commits.some((commit) => Date.parse(commit.date) > at),
      };
      threads.set(root.id, thread);
    }
    if (c.id !== root.id) thread.replies.push(c);
  }
  return [...threads.values()];
}

/** Roughly how many tokens a text is, without a tokenizer: four characters each. */
const roughTokens = (text: string) => Math.ceil(text.length / 4);

/** The first `max` tokens of a text, cut at a paragraph or line end when one is near. */
function cutAt(text: string, max: number): string {
  if (roughTokens(text) <= max) return text;
  const limit = max * 4;
  const para = text.lastIndexOf("\n\n", limit);
  const line = text.lastIndexOf("\n", limit);
  const at = para > limit * 0.6 ? para : line > limit * 0.6 ? line : limit;
  const dropped = text.slice(at).split(/\s+/).filter(Boolean).length;
  return `${text.slice(0, at).trimEnd()}\n\n[… ${dropped} more words cut: the thread is longer than a lesson needs]`;
}

/**
 * The thread within a token budget. Review comments by AI reviewers run to thousands of tokens
 * of prose (one in four threads in a team trial, taking a third of all drafting input); a
 * rule comes from the opening point, so the root keeps most of the budget and the replies a
 * small share. The drafter, the judge and the document check all see the same cut text.
 */
export function trimThread(
  thread: ReviewThread,
  max = THREAD_TOKENS,
): { thread: ReviewThread; trimmed: boolean } {
  const rootTokens = roughTokens(thread.root.body);
  const replyTokens = thread.replies.reduce((n, r) => n + roughTokens(r.body), 0);
  if (rootTokens + replyTokens <= max) return { thread, trimmed: false };
  const forReplies = Math.min(replyTokens, Math.round(max * 0.2));
  const root = { ...thread.root, body: cutAt(thread.root.body, max - forReplies) };
  // Replies share their budget in order: a later one may be cut to nothing but a marker.
  let left = forReplies;
  const replies = thread.replies.map((r) => {
    const body = left > 40 ? cutAt(r.body, left) : "[… reply cut]";
    left = Math.max(0, left - roughTokens(body));
    return { ...r, body };
  });
  return { thread: { ...thread, root, replies }, trimmed: true };
}
