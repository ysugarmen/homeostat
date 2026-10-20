import type { Config } from "./config.ts";

/** The `core` area: team-wide in a one-repo KB, shared across repos in a multi-repo one. */
const CORE = "core";

/**
 * Where a file sits in the KB. A multi-repo KB (one with `repos:`) keeps shared rules in
 * `knowledge/core/` and each repo's in `knowledge/<repo>/<area>/`; a one-repo KB keeps
 * `knowledge/<area>/`. Documents add a `docs/` folder under the area in both.
 */
export interface KbLocation {
  /** The repo's short name; undefined for shared rules and for one-repo KBs. */
  repo?: string;
  area: string;
  kind: "rule" | "doc";
}

/** Repo short names that would clash with KB folders. */
export const RESERVED_REPO_NAMES = [CORE, "docs"] as const;

export const isMultiRepo = (config: Pick<Config, "repos">): boolean => config.repos !== undefined;
export const repoNames = (config: Pick<Config, "repos">): string[] =>
  Object.keys(config.repos ?? {});

/**
 * Reads a KB path. `repos` are the multi-repo KB's short names; omit them for a one-repo KB.
 * Returns undefined for a path that fits neither layout.
 */
export function locate(path: string, repos?: readonly string[]): KbLocation | undefined {
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts[0] !== "knowledge" || !parts.at(-1)?.endsWith(".md")) return undefined;
  const rest = parts.slice(1, -1);
  const doc = rest.at(-1) === "docs";
  const folders = doc ? rest.slice(0, -1) : rest;
  const kind = doc ? "doc" : "rule";
  if (!repos) return folders.length === 1 && folders[0] ? { area: folders[0], kind } : undefined;
  if (folders.length === 1 && folders[0] === CORE) return { area: CORE, kind };
  const [repo, area] = folders;
  if (folders.length === 2 && repo && area && repos.includes(repo)) return { repo, area, kind };
  return undefined;
}

/** The repo a KB path belongs to, if any. */
export const repoOf = (path: string, config: Pick<Config, "repos">): string | undefined =>
  locate(path, isMultiRepo(config) ? repoNames(config) : undefined)?.repo;

/** The area names a repo's rules may use (core included); in a one-repo KB, the top-level areas. */
export function areasOf(config: Pick<Config, "repos" | "areas">, repo?: string): string[] {
  const own = repo ? Object.keys(config.repos?.[repo]?.areas ?? {}) : Object.keys(config.areas);
  return [CORE, ...own];
}

/**
 * Whether `name` names an area, as members, teams and team-only lists write it: a plain area
 * in a one-repo KB; `core` (shared), `<repo>/core` or `<repo>/<area>` in a multi-repo one.
 */
export function isKnownArea(config: Pick<Config, "repos" | "areas">, name: string): boolean {
  if (name === CORE) return true;
  if (!isMultiRepo(config)) return Object.hasOwn(config.areas, name);
  const [repo, area, extra] = name.split("/");
  return (
    !extra &&
    !!repo &&
    !!area &&
    repoNames(config).includes(repo) &&
    areasOf(config, repo).includes(area)
  );
}

/** A repo's areas (name → globs); in a one-repo KB, the top-level areas. */
export function areaMap(
  config: Pick<Config, "repos" | "areas">,
  repo?: string,
): Record<string, readonly string[]> {
  return repo ? (config.repos?.[repo]?.areas ?? {}) : config.areas;
}

/** The short name of the repo whose source is `owner/name`, in a multi-repo KB. */
export function repoForSource(config: Pick<Config, "repos">, source: string): string | undefined {
  const key = source.toLowerCase();
  return Object.entries(config.repos ?? {}).find(([, r]) => r.source.toLowerCase() === key)?.[0];
}

/**
 * Where a rule is filed: `knowledge/<area>/<id>.md` in a one-repo KB; in a multi-repo one,
 * `knowledge/<repo>/<area>/<id>.md`, or `knowledge/core/<id>.md` for a shared rule (no repo).
 * In a topic KB this is the rule's virtual path, which foldRules places in its topic file.
 */
export function ruleFilePath(
  config: Pick<Config, "repos">,
  at: { repo?: string | undefined; area: string; id: string },
): string {
  if (!isMultiRepo(config) || !at.repo) return `knowledge/${at.area}/${at.id}.md`;
  return `knowledge/${at.repo}/${at.area}/${at.id}.md`;
}

/** Where a document is filed: the rule's folder, plus `docs/`. */
export function docFilePath(
  config: Pick<Config, "repos">,
  at: { repo?: string | undefined; area: string; topic: string },
): string {
  const folder = isMultiRepo(config) && at.repo ? `${at.repo}/${at.area}` : at.area;
  return `knowledge/${folder}/docs/${at.topic.replace(/\.md$/, "")}.md`;
}

/**
 * Whether two KB paths can hold the same lesson: the same repo, or either one shared. Two
 * repos' rules are never duplicates of each other (each repo has its own config.py).
 */
export function comparable(a: string, b: string, config: Pick<Config, "repos">): boolean {
  const ra = repoOf(a, config);
  const rb = repoOf(b, config);
  return ra === rb || ra === undefined || rb === undefined;
}
