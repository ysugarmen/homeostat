import type { Config } from "./config.ts";
import type { Frontmatter } from "./schema.ts";

/** What the auto-merge gates look at: an entry plus its risky-content findings. */
export interface MergeCandidate {
  frontmatter: Frontmatter;
  risks: readonly string[];
}

export type AutoMergeDecision = { auto: true } | { auto: false; reason: string };

/**
 * Whether one entry may merge without a reviewer (security plan T1). The score says a lesson is
 * genuine (a member's review comment led to a code change); the other gates check what the rule
 * says and who wrote it. Any failed gate sends the entry to a human.
 */
export function autoMergeDecision(c: MergeCandidate, config: Config): AutoMergeDecision {
  const gate = config.scoring.autoMerge;
  const fm = c.frontmatter;
  const no = (reason: string): AutoMergeDecision => ({ auto: false, reason });
  if (!gate.enabled) return no("auto-merge is off");
  if (fm.status !== "accepted" || fm.score < config.scoring.autoMergeThreshold) {
    return no(`score ${fm.score} is below the threshold (${config.scoring.autoMergeThreshold})`);
  }
  if (fm.source.type !== "pr-feedback") return no("only review feedback from a member auto-merges");
  if (fm.source.changedCode !== true) return no("no code change followed the comment");
  if (!config.team.members.some((m) => m.id === fm.source.author)) {
    return no(`${fm.source.author} is not a team member`);
  }
  if (c.risks.length > 0) return no("flagged by the risky-content check");
  if (fm.flags?.length) return no("flagged by a member");
  if (gate.excludeAreas.includes(fm.area)) return no(`area ${fm.area} always needs a reviewer`);
  if (gate.areas.length > 0 && !gate.areas.includes(fm.area)) {
    return no(`area ${fm.area} is not in scoring.autoMerge.areas`);
  }
  return { auto: true };
}

/** Splits a run's entries into those that auto-merge (at most `maxPerRun`) and the rest. */
export function splitAutoMerge<T extends MergeCandidate>(
  entries: readonly T[],
  config: Config,
): { auto: T[]; review: { entry: T; reason: string }[] } {
  const auto: T[] = [];
  const review: { entry: T; reason: string }[] = [];
  for (const entry of entries) {
    const d = autoMergeDecision(entry, config);
    if (!d.auto) review.push({ entry, reason: d.reason });
    else if (auto.length >= config.scoring.autoMerge.maxPerRun) {
      review.push({
        entry,
        reason: `over the per-run cap (${config.scoring.autoMerge.maxPerRun})`,
      });
    } else auto.push(entry);
  }
  return { auto, review };
}
