import type { RepoRef } from "../providers/types.ts";

export interface CommentRef {
  host: "bitbucket" | "github";
  repo: RepoRef;
  pullRequest: number;
  comment: number;
}

export class CommentUrlError extends Error {}

/** Parses a Bitbucket `#comment-N` or GitHub `#discussion_rN` PR review comment link. */
export function parseCommentUrl(url: string): CommentRef {
  const bb =
    /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)[^#]*#comment-(\d+)$/.exec(
      url,
    );
  if (bb) {
    const [, owner = "", name = "", pr = "", comment = ""] = bb;
    return { host: "bitbucket", repo: { owner, name }, pullRequest: +pr, comment: +comment };
  }
  const gh =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)[^#]*#(discussion_r|issuecomment-)(\d+)$/.exec(
      url,
    );
  if (gh) {
    const [, owner = "", name = "", pr = "", kind, comment = ""] = gh;
    if (kind === "issuecomment-") {
      throw new CommentUrlError(
        "only review comments (on a line of the diff) are supported; this is a general PR comment",
      );
    }
    return { host: "github", repo: { owner, name }, pullRequest: +pr, comment: +comment };
  }
  throw new CommentUrlError(`not a Bitbucket or GitHub PR comment URL: ${url}`);
}

/** One key per comment whatever form its URL takes (overview, diff, short link). */
export const commentKey = (ref: CommentRef) =>
  `${ref.host}:${ref.repo.owner}/${ref.repo.name}#${ref.pullRequest}/${ref.comment}`.toLowerCase();

/** The key for an entry's `source.url`, or undefined when it is not a review-comment link. */
export function commentKeyOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return commentKey(parseCommentUrl(url));
  } catch {
    return undefined;
  }
}
