import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STATE_BRANCH } from "@homeostat/core";

export interface RefreshResult {
  /** Whether anything the dashboard reads moved: the checkout or a fetched branch. */
  changed: boolean;
  /** Commits fast-forwarded into the checkout. */
  pulled: number;
  /** Commits on the base branch the checkout could not take, and why. */
  behind: number;
  reason?: string;
  /** Set when origin could not be reached; the checkout is shown as it is. */
  error?: string;
}

/** Fails fast instead of waiting on a password prompt nobody can see. */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" };

const run = promisify(execFile);

/** Async, so a slow fetch never freezes the app's window. */
async function git(dir: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", dir, ...args], { env: GIT_ENV, timeout: 60_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Every ref the dashboard reads, so a refresh can tell whether to redraw. */
const fingerprint = async (dir: string) =>
  `${await git(dir, "rev-parse", "HEAD")}\n${await git(dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin")}`;

/**
 * Brings a KB checkout up to date for the dashboard, the way `homeostat sync` does, but read-only
 * towards origin: it fetches the base branch, the daily run's state and teammates' candidates,
 * and fast-forwards only a clean checkout on the base branch. It never pushes, and never touches
 * local changes or another branch.
 */
export async function refreshCheckout(dir: string, base: string): Promise<RefreshResult> {
  const before = await fingerprint(dir);
  const fetched = await git(
    dir,
    "fetch",
    "--quiet",
    "--prune",
    "origin",
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
    `+refs/heads/${STATE_BRANCH}:refs/remotes/origin/${STATE_BRANCH}`,
    "+refs/heads/candidates/*:refs/remotes/origin/candidates/*",
  );
  // A state branch that does not exist yet (no daily run so far) fails the fetch; try without it.
  const fetchedBase =
    fetched !== undefined ||
    (await git(
      dir,
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
      "+refs/heads/candidates/*:refs/remotes/origin/candidates/*",
    )) !== undefined;
  if (!fetchedBase)
    return {
      changed: false,
      pulled: 0,
      behind: 0,
      error: "could not fetch from origin; showing the checkout as it is",
    };

  let pulled = 0;
  let behind = 0;
  let reason: string | undefined;
  const ahead = Number(
    (await git(dir, "rev-list", "--count", `HEAD..refs/remotes/origin/${base}`)) ?? 0,
  );
  if (ahead > 0) {
    const onBase = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD")) === base;
    const clean = ((await git(dir, "status", "--porcelain", "--untracked-files=no")) ?? "x") === "";
    if (
      onBase &&
      clean &&
      (await git(dir, "merge", "--ff-only", "--quiet", `refs/remotes/origin/${base}`)) !== undefined
    )
      pulled = ahead;
    else {
      behind = ahead;
      reason = !onBase ? `it is not on ${base}` : "it has local changes";
    }
  }
  return {
    changed: (await fingerprint(dir)) !== before,
    pulled,
    behind,
    ...(reason ? { reason } : {}),
  };
}
