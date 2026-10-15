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

/** A file's exact text on a ref (git() trims, which would change a lesson's hash). */
export function showFile(dir: string, ref: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
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

  const tmp = mkdtempSync(join(tmpdir(), "homeostat-index-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    // commit-tree needs an identity; fall back to a neutral one rather than fail.
    if (!git(dir, "config", "user.name")) {
      Object.assign(env, { GIT_AUTHOR_NAME: "homeostat", GIT_COMMITTER_NAME: "homeostat" });
    }
    if (!git(dir, "config", "user.email")) {
      Object.assign(env, {
        GIT_AUTHOR_EMAIL: "homeostat@localhost",
        GIT_COMMITTER_EMAIL: "homeostat@localhost",
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

/**
 * Builds a commit of `base` plus `files` (path → content) with a throwaway index, without touching
 * the working tree, the real index or any branch. Returns the commit id.
 */
export function commitTree(
  dir: string,
  base: string | undefined,
  files: Record<string, string>,
  message: string,
): string {
  const tmp = mkdtempSync(join(tmpdir(), "homeostat-index-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    if (!git(dir, "config", "user.name")) {
      Object.assign(env, { GIT_AUTHOR_NAME: "homeostat", GIT_COMMITTER_NAME: "homeostat" });
    }
    if (!git(dir, "config", "user.email")) {
      Object.assign(env, {
        GIT_AUTHOR_EMAIL: "homeostat@localhost",
        GIT_COMMITTER_EMAIL: "homeostat@localhost",
      });
    }
    // No base starts a new history (the first state commit).
    gitOrThrow(dir, base ? ["read-tree", base] : ["read-tree", "--empty"], { env });
    for (const [path, content] of Object.entries(files)) {
      const blob = gitOrThrow(dir, ["hash-object", "-w", "--stdin"], { input: content });
      gitOrThrow(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
    const tree = gitOrThrow(dir, ["write-tree"], { env });
    return gitOrThrow(dir, ["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", message], {
      env,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Force-pushes a commit to a branch on origin (for transport branches only). */
export function forcePush(dir: string, commit: string, branch: string, remote = "origin") {
  gitOrThrow(dir, ["push", "--quiet", "--force", remote, `${commit}:refs/heads/${branch}`]);
}
