import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs git in `dir`; undefined when it fails (not a repo, unknown ref, ...). */
export function git(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    return undefined;
  }
}

/** Runs git in `dir` and throws with git's own message when it fails. */
function gitOrThrow(
  dir: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      input: opts.input ?? "",
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

/** True when `path` exists in the tree of `ref`. */
export function existsOnRef(dir: string, ref: string, path: string): boolean {
  return git(dir, "cat-file", "-e", `${ref}:${path}`) !== undefined;
}

/**
 * Commits one file onto `branch` with git plumbing and a throwaway index, so the working tree,
 * the real index and HEAD are untouched. A new branch starts from HEAD.
 */
export function commitFile(
  dir: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const old = git(dir, "rev-parse", "--verify", "--quiet", ref);
  const base = old ?? git(dir, "rev-parse", "--verify", "--quiet", "HEAD");
  if (!base) throw new Error("the knowledge base repo has no commits yet");

  const tmp = mkdtempSync(join(tmpdir(), "kbx-index-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    // commit-tree needs an identity; fall back to a neutral one rather than fail.
    if (!git(dir, "config", "user.name")) {
      Object.assign(env, { GIT_AUTHOR_NAME: "kbx", GIT_COMMITTER_NAME: "kbx" });
    }
    if (!git(dir, "config", "user.email")) {
      Object.assign(env, {
        GIT_AUTHOR_EMAIL: "kbx@localhost",
        GIT_COMMITTER_EMAIL: "kbx@localhost",
      });
    }
    gitOrThrow(dir, ["read-tree", base], { env });
    const blob = gitOrThrow(dir, ["hash-object", "-w", "--stdin"], { input: content });
    gitOrThrow(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    const tree = gitOrThrow(dir, ["write-tree"], { env });
    const commit = gitOrThrow(dir, ["commit-tree", tree, "-p", base, "-m", message], { env });
    gitOrThrow(dir, ["update-ref", ref, commit, old ?? ""]);
    return commit;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function pushBranch(dir: string, branch: string, remote = "origin") {
  gitOrThrow(dir, ["push", "--quiet", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
}
