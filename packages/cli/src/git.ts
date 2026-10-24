import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** The most a network git call (fetch, push) may take before it is stopped; 2 minutes by default. */
export const networkTimeout = () => Number(process.env.HOMEOSTAT_GIT_TIMEOUT_MS) || 120_000;

/**
 * An environment that makes a dead connection fail in seconds rather than hang: ssh gives up on
 * an unreachable or silent server, and https on a stalled transfer. A developer's own ssh command
 * (`GIT_SSH_COMMAND`, `core.sshCommand`) is left alone.
 */
export function networkEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GIT_HTTP_LOW_SPEED_LIMIT: base.GIT_HTTP_LOW_SPEED_LIMIT ?? "1000",
    GIT_HTTP_LOW_SPEED_TIME: base.GIT_HTTP_LOW_SPEED_TIME ?? "30",
  };
  if (!base.GIT_SSH_COMMAND && !git(dir, "config", "core.sshCommand"))
    env.GIT_SSH_COMMAND =
      "ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=2";
  return env;
}

/** git() for calls that reach the remote: bounded in time, undefined on failure or timeout. */
export function gitNet(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: networkEnv(dir),
      timeout: networkTimeout(),
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
  opts: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      input: opts.input ?? "",
      env: opts.env ?? process.env,
      ...(opts.timeout ? { timeout: opts.timeout } : {}),
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
  /** The file's new text; null removes it. */
  content: string | null,
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
    if (content === null) {
      gitOrThrow(dir, ["update-index", "--force-remove", "--", path], { env });
    } else {
      const blob = gitOrThrow(dir, ["hash-object", "-w", "--stdin"], { input: content });
      gitOrThrow(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
    }
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
  gitOrThrow(dir, ["push", "--quiet", "--force", remote, `${commit}:refs/heads/${branch}`], {
    env: networkEnv(dir),
    timeout: networkTimeout(),
  });
}

/**
 * Three-way merge of two edits to one file (`git merge-file`), or undefined when they conflict.
 * Section edits to different sections of a document merge cleanly.
 */
export function mergeText(base: string, ours: string, theirs: string): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    writeFileSync(o as string, ours);
    writeFileSync(b as string, base);
    writeFileSync(t as string, theirs);
    return execFileSync("git", ["merge-file", "-p", o as string, b as string, t as string], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined; // a non-zero exit is the number of conflicts
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
