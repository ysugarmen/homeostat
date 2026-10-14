import type { Config } from "./config.ts";
import type { Entry } from "./entry.ts";

/**
 * Team-only areas (`security.teamOnlyAreas`) keep a team's rules from spreading: they are never
 * exported into code repos, and sessions and MCP calls see them only for members of that area.
 * This limits spread, not access: anyone who can read the KB repo can read its files.
 */
export function isTeamOnly(area: string, config: Config): boolean {
  return config.security.teamOnlyAreas.includes(area);
}

/** The entries a member's session may see; with no known member, team-only areas are hidden. */
export function visibleTo<E extends Pick<Entry, "frontmatter">>(
  entries: readonly E[],
  config: Config,
  member: string | undefined,
): E[] {
  const areas = new Set(config.team.members.find((m) => m.id === member)?.areas ?? []);
  return entries.filter(
    (e) => !isTeamOnly(e.frontmatter.area, config) || areas.has(e.frontmatter.area),
  );
}

/** The entries that may leave the KB repo, e.g. into a code repo's rules files. */
export function exportable<E extends Pick<Entry, "frontmatter">>(
  entries: readonly E[],
  config: Config,
): E[] {
  return entries.filter((e) => !isTeamOnly(e.frontmatter.area, config));
}
