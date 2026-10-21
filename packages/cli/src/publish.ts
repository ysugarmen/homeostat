import type { Provider, RepoRef } from "@homeostat/core";
import type { Io } from "./cli.ts";
import { plural } from "./format.ts";
import { commitFile, git, pushBranch } from "./git.ts";

export interface FileChange {
  path: string;
  /** The file's new text; null removes it (a rule that moved into a topic file). */
  text: string | null;
  /** Commit message for this file. */
  message: string;
}

export interface PublishOptions {
  root: string;
  /** Branch name prefix; a free name is picked (`name`, `name-2`, ...). */
  branch: string;
  changes: FileChange[];
  provider: Provider;
  kbRepo: RepoRef;
  base: string;
  title: string;
  body: string;
  io: Io;
  /**
   * Mark the commits `[skip ci]`: for a PR merged at once, whose branch is gone before a pipeline
   * could start. The squash merge carries its own message, so the base branch still runs CI.
   */
  skipCi?: boolean;
}

/** First of `base`, `base-2`, ... that exists neither locally nor on origin. */
function freeBranch(root: string, base: string): string {
  const taken = (name: string) =>
    git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) !== undefined ||
    Boolean(git(root, "ls-remote", "--heads", "origin", name));
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * Commits each change to a new branch cut from the base (working tree untouched), pushes it and
 * opens one PR on the KB repo. Without an origin the branch stays local and no PR is opened.
 */
export async function publish(
  opts: PublishOptions,
): Promise<{ branch: string; pr?: { id: number; url: string } }> {
  const { root, io } = opts;
  const branch = freeBranch(root, opts.branch);
  const baseRef =
    git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${opts.base}`) ??
    git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${opts.base}`);
  if (baseRef) git(root, "branch", branch, baseRef);
  for (const c of opts.changes)
    commitFile(root, branch, c.path, c.text, opts.skipCi ? `${c.message} [skip ci]` : c.message);
  io.stdout(`committed ${plural(opts.changes.length, "file")} to ${branch}\n`);

  if (git(root, "remote", "get-url", "origin") === undefined) {
    io.stdout("no origin remote: branch left local, no PR opened\n");
    return { branch };
  }
  pushBranch(root, branch);
  const pr = await opts.provider.openPullRequest(opts.kbRepo, {
    title: opts.title,
    body: opts.body,
    sourceBranch: branch,
    targetBranch: opts.base,
  });
  io.stdout(`opened ${pr.url}\n`);
  return { branch, pr };
}
