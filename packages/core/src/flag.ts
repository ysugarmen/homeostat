import type { Config } from "./config.ts";
import { type Entry, formatEntry } from "./entry.ts";
import type { Frontmatter } from "./schema.ts";
import { score } from "./score.ts";

export interface Flag {
  /** Member id of whoever reports it. */
  by: string;
  reason: string;
  /** ISO date. */
  date: string;
}

/**
 * Records a "this is wrong" report: the flag is added, an accepted entry goes back to `disputed`
 * for review, and the score drops by the flag weight. Returns the new file text.
 */
export function flagEntry(entry: Entry, flag: Flag, config: Config): string {
  const fm: Frontmatter = {
    ...entry.frontmatter,
    flags: [...(entry.frontmatter.flags ?? []), flag],
  };
  if (fm.status === "accepted") fm.status = "disputed";
  fm.score = score(fm, { config }).score;
  return formatEntry(fm, entry.body);
}
