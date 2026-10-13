import type { Commit, PullRequest, ReviewComment } from "../providers/types.ts";

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
