import {
  type Config,
  findRule,
  foldRules,
  isTopicFile,
  type KbFiles,
  mergeTopicFile,
} from "@homeostat/core";
import { commitFile, git, showFile } from "./git.ts";
import type { FileChange } from "./publish.ts";

/** The KB's files at a git ref: everything under knowledge/, plus homeostat.yaml. */
export function refFiles(root: string, ref: string): KbFiles {
  const files: KbFiles = {};
  const listed = git(root, "ls-tree", "-r", "--name-only", ref, "--", "knowledge") ?? "";
  for (const path of listed.split("\n").filter(Boolean)) {
    const text = showFile(root, ref, path);
    if (text !== undefined) files[path] = text;
  }
  const config = showFile(root, ref, "homeostat.yaml");
  if (config !== undefined) files["homeostat.yaml"] = config;
  return files;
}

/**
 * A rule's one-rule text at `ref`, by its path `…/<area>/<id>.md`: its own file, or its section
 * in a topic file of the same folder. Other paths (documents) read as files.
 */
export function showRule(root: string, ref: string, path: string): string | undefined {
  const own = showFile(root, ref, path);
  if (own !== undefined || !path.endsWith(".md")) return own;
  const dir = path.slice(0, path.lastIndexOf("/"));
  const files: KbFiles = {};
  for (const p of (git(root, "ls-tree", "--name-only", ref, `${dir}/`) ?? "").split("\n")) {
    if (p.endsWith(".md")) files[p] = showFile(root, ref, p) ?? "";
  }
  return findRule(files, path);
}

/**
 * Rule changes, at their one-rule paths, as the file changes to commit at `ref`: folded into
 * their topic files when the KB uses topics (sorted, moved, emptied files removed), unchanged
 * otherwise. Documents and other files pass through.
 */
export function foldChanges(
  root: string,
  ref: string,
  changes: readonly FileChange[],
  config: Config,
): FileChange[] {
  const isRule = (c: FileChange) => c.path.startsWith("knowledge/") && !/\/docs\//.test(c.path);
  const rules = changes.filter(isRule);
  if (rules.length === 0) return [...changes];
  const message = new Map(rules.map((c) => [c.path, c.message]));
  const folded = foldRules(
    refFiles(root, ref),
    rules.map((c) => ({ path: c.path, text: c.text })),
    config,
  );
  const out: FileChange[] = changes.filter((c) => !isRule(c));
  for (const [path, text] of Object.entries(folded)) {
    out.push({ path, text, message: message.get(path) ?? `homeostat: update ${path}` });
  }
  return out;
}

/** The ref a commit to `branch` builds on: the branch if it exists, else HEAD (where it is cut). */
export const branchRef = (root: string, branch: string): string =>
  git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
    ? `refs/heads/${branch}`
    : "HEAD";

/**
 * Puts a Homeostat PR branch back on top of the base when they conflict: each file the PR
 * changed is taken from the PR if the base left it alone, kept if the PR did, and merged
 * section by section if both changed a topic file. The result is committed onto the base
 * and force-pushed to the PR's branch (Homeostat's own, never a person's). Fails, changing
 * nothing, when the same rule changed on both sides or a non-topic file conflicts.
 */
export function rebuildOnBase(
  root: string,
  base: string,
  branch: string,
): { rebuilt: true; sha: string } | { rebuilt: false; reason: string } {
  const B = `refs/remotes/origin/${base}`;
  const S = `refs/remotes/origin/${branch}`;
  git(root, "fetch", "--quiet", "origin", `+refs/heads/${base}:${B}`, `+refs/heads/${branch}:${S}`);
  const mb = git(root, "merge-base", B, S);
  if (!mb) return { rebuilt: false, reason: `${branch} shares no history with ${base}` };
  const changed = (git(root, "diff", "--name-only", mb, S) ?? "").split("\n").filter(Boolean);
  const out: Record<string, string | null> = {};
  const both: string[] = [];
  for (const path of changed) {
    const was = showFile(root, mb, path);
    const ours = showFile(root, B, path);
    const theirs = showFile(root, S, path);
    if (ours === was) out[path] = theirs ?? null;
    else if (theirs === was || ours === theirs) continue;
    else if (isTopicFile(ours ?? "") || isTopicFile(theirs ?? "")) {
      const merged = mergeTopicFile(path, was, ours ?? "", theirs ?? "");
      if (merged.conflicts.length) both.push(...merged.conflicts.map((id) => `${path}#${id}`));
      else out[path] = merged.text;
    } else {
      return { rebuilt: false, reason: `${path} changed on both sides and is not a topic file` };
    }
  }
  if (both.length) {
    return { rebuilt: false, reason: `the same rules changed on both sides: ${both.join(", ")}` };
  }
  const tmp = `homeostat-rebuild-${process.pid}`;
  git(root, "branch", "--force", tmp, B);
  for (const [path, text] of Object.entries(out)) {
    commitFile(root, tmp, path, text, `homeostat: rebuild ${path} on ${base}`);
  }
  const pushed = git(
    root,
    "push",
    "--quiet",
    "--force",
    "origin",
    `refs/heads/${tmp}:refs/heads/${branch}`,
  );
  const sha = git(root, "rev-parse", tmp) ?? "";
  git(root, "branch", "-D", tmp);
  return pushed === undefined
    ? { rebuilt: false, reason: `could not push the rebuilt ${branch}` }
    : { rebuilt: true, sha };
}

/**
 * Pushes an empty commit on top of `sha` to `branch`, without force. Bitbucket can miss a force
 * push for minutes and keep judging a PR's old commit; an ordinary push makes it look again.
 */
export function nudgeBranch(root: string, branch: string, sha: string): string | undefined {
  const tree = git(root, "rev-parse", `${sha}^{tree}`);
  if (!tree) return undefined;
  const next = git(root, "commit-tree", tree, "-p", sha, "-m", "homeostat: refresh the PR");
  if (!next) return undefined;
  return git(root, "push", "--quiet", "origin", `${next}:refs/heads/${branch}`) === undefined
    ? undefined
    : next;
}
