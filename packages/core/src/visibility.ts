import type { Config } from "./config.ts";
import { isMultiRepo, repoOf } from "./layout.ts";

/**
 * Team-only areas (`security.teamOnlyAreas`) keep a team's rules from spreading: they are never
 * exported into code repos, and sessions and MCP calls see them only for members of that area.
 * This limits spread, not access: anyone who can read the KB repo can read its files.
 */
export function isTeamOnly(area: string, config: Config): boolean {
  return config.security.teamOnlyAreas.includes(area);
}

/** Something with an area, and (when known) its KB path, which tells its repo. */
type Placed = { frontmatter: { area: string }; path?: string };

/** An area as members and team-only lists name it: `<repo>/<area>` for a repo's rules. */
function areaKey(e: Placed, config: Config): string {
  const repo = e.path ? repoOf(e.path, config) : undefined;
  return repo ? `${repo}/${e.frontmatter.area}` : e.frontmatter.area;
}

/** The entries a member's session may see; with no known member, team-only areas are hidden. */
export function visibleTo<E extends Placed>(
  entries: readonly E[],
  config: Config,
  member: string | undefined,
): E[] {
  const areas = new Set(config.team.members.find((m) => m.id === member)?.areas ?? []);
  return entries.filter((e) => {
    const key = areaKey(e, config);
    return !isTeamOnly(key, config) || areas.has(key);
  });
}

/** The entries that may leave the KB repo, e.g. into a code repo's rules files. */
export function exportable<E extends Placed>(entries: readonly E[], config: Config): E[] {
  return entries.filter((e) => !isTeamOnly(areaKey(e, config), config));
}

/**
 * What a session in `repo` sees of a multi-repo KB: the shared rules and documents
 * (knowledge/core/) plus that repo's own. With no repo, shared ones only. A one-repo KB
 * shows everything everywhere.
 */
export function inRepo<T extends { path: string }>(
  items: readonly T[],
  config: Config,
  repo: string | undefined,
): T[] {
  if (!isMultiRepo(config)) return [...items];
  return items.filter((i) => {
    const own = repoOf(i.path, config);
    return own === undefined || own === repo;
  });
}
