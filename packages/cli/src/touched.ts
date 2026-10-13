import { git } from "./init.ts";

const MAX_PATHS = 500;
const RECENT_COMMITS = 10;

const lines = (text: string | undefined) => (text ?? "").split("\n").filter(Boolean);

/** Paths from `git status --porcelain`, using the new name for renames. */
function uncommitted(dir: string): string[] {
  return lines(git(dir, "status", "--porcelain=v1", "--untracked-files=all")).map((line) => {
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    return (arrow === -1 ? path : path.slice(arrow + 4)).replace(/^"|"$/g, "");
  });
}

function baseRef(dir: string): string | undefined {
  const remoteHead = git(dir, "rev-parse", "--abbrev-ref", "origin/HEAD");
  if (remoteHead && remoteHead !== "origin/HEAD") return remoteHead;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(dir, "rev-parse", "--verify", "--quiet", candidate)) return candidate;
  }
  return undefined;
}

/**
 * Repo-relative paths a session in `dir` is likely to touch: uncommitted changes, the current
 * branch's changes against its base, then files from recent commits. Best first, de-duplicated.
 */
export function touchedPaths(dir: string): string[] {
  const base = baseRef(dir);
  const branch = base ? lines(git(dir, "diff", "--name-only", `${base}...HEAD`)) : [];
  const recent = lines(
    git(dir, "log", `-n${RECENT_COMMITS}`, "--name-only", "--format=", "--no-renames", "HEAD"),
  );
  return [...new Set([...uncommitted(dir), ...branch, ...recent])].slice(0, MAX_PATHS);
}
