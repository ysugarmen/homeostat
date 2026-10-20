import { type Config, findRule, foldRules, type KbFiles } from "@homeostat/core";
import { git, showFile } from "./git.ts";
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
