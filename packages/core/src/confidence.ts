import type { Decision } from "./automation.ts";
import { CORE_AREA } from "./check.ts";
import type { Config } from "./config.ts";
import type { Entry } from "./entry.ts";

/**
 * How sure the team can be that a lesson is right and worth every agent following, 0–100. The
 * daily run merges lessons at or above `accept`, declines those below `decline`, and sends the
 * rest to a reviewer. Every point comes with a reason, printed in the daily PR (automation, step 3).
 */
export interface ConfidenceInput {
  entry: Entry;
  config: Config;
  /** The member the lesson came from: its writer, or the reviewer whose comment it is drawn from. */
  originator: string;
  /** Times the same lesson turned up independently in this run, the first included. */
  occurrences?: number;
  /** The model's own rating of a drafted lesson, 0–1. */
  modelRating?: number;
  /** Risky-content findings: they always send the lesson to a person. */
  risks?: readonly string[];
  /** Validation errors other than risky content: the lesson cannot be merged. */
  errors?: readonly string[];
  /** An accepted rule this lesson repeats: it reconfirms that rule instead of adding a new one. */
  duplicateOf?: string;
  /** Accepted rules this lesson contradicts. */
  conflictsWith?: readonly string[];
}

export interface Confidence {
  score: number;
  parts: { label: string; delta: number }[];
  decision: Decision;
  /** One line for the PR and the developer's notice. */
  reason: string;
}

const SPECIFIC =
  /`[^`]+`|\w+\(\)|[\w.-]+\/[\w./*-]+|@[\w-]+\/[\w-]+|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/;
const VAGUE_TITLE = /^(lesson|note|rule|todo|misc|fix|update)\s*\d*$/i;

export function confidence(input: ConfidenceInput): Confidence {
  const { entry, config } = input;
  const c = config.scoring.confidence;
  const fm = entry.frontmatter;
  const parts: Confidence["parts"] = [];
  const add = (label: string, delta: number) => {
    if (delta !== 0) parts.push({ label, delta });
  };

  const sourceBase = {
    "pr-feedback": fm.source.changedCode ? c.base.prFeedbackChangedCode : c.base.prFeedback,
    manual: c.base.manual,
    "agent-handoff": c.base.agentHandoff,
    "deep-dive": c.base.deepDive,
  }[fm.source.type];
  add(
    fm.source.type === "pr-feedback"
      ? fm.source.changedCode
        ? "review comment followed by a code change"
        : "review comment, no code change after it"
      : fm.source.type === "agent-handoff"
        ? "written by an agent"
        : fm.source.type === "deep-dive"
          ? "produced by the deep dive"
          : "written by a team member",
    sourceBase,
  );

  const member = config.team.members.find((m) => m.id === input.originator);
  if (member) {
    add(`from ${member.id} (${member.role})`, c.roles[member.role]);
    const owns =
      member.areas.includes(fm.area) ||
      Object.values(config.teams).some(
        (t) => t.members.includes(member.id) && t.areas.includes(fm.area),
      );
    if (owns) add(`${member.id} works in ${fm.area}`, c.bonus.areaOwner);
  }

  const text = `${entry.sections.rule ?? ""} ${fm.title}`;
  if (SPECIFIC.test(text)) add("names a concrete function, path or package", c.bonus.specific);
  const words = fm.title.trim().split(/\s+/).length;
  if (VAGUE_TITLE.test(fm.title.trim()) || words < 3)
    add(`vague title "${fm.title}"`, -c.penalty.vagueTitle);
  else add("clear title", c.bonus.goodTitle);

  const repeats = Math.min(2, Math.max(0, (input.occurrences ?? 1) - 1));
  if (repeats) add(`seen ${repeats + 1} times independently`, repeats * c.bonus.repeat);
  if (input.modelRating !== undefined) {
    add("model rating", Math.round((input.modelRating - 0.5) * 2 * c.bonus.modelRating));
  }
  for (const f of fm.flags ?? []) add(`flagged by ${f.by}`, -c.penalty.flag);
  if (input.conflictsWith?.length)
    add(`contradicts ${input.conflictsWith.join(", ")}`, -c.penalty.conflict);

  const score = Math.max(
    0,
    Math.min(
      100,
      parts.reduce((n, p) => n + p.delta, 0),
    ),
  );
  const accept =
    fm.area === CORE_AREA || fm.scope.some((g) => g === "**") ? c.coreAccept : c.accept;
  const summary = `confidence ${score}`;

  // Hard rules first: some outcomes never depend on the score.
  if (input.errors?.length)
    return { score, parts, decision: "declined", reason: `does not validate: ${input.errors[0]}` };
  if (input.duplicateOf) {
    return {
      score,
      parts,
      decision: "declined",
      reason: `duplicate of ${input.duplicateOf}, which it reconfirms`,
    };
  }
  if (input.risks?.length)
    return {
      score,
      parts,
      decision: "review",
      reason: `${summary}; risky content always goes to a person`,
    };
  if (input.conflictsWith?.length && score >= c.decline) {
    return {
      score,
      parts,
      decision: "review",
      reason: `${summary}; contradicts ${input.conflictsWith.join(", ")}`,
    };
  }
  const gate = config.scoring.autoMerge;
  const inScope =
    gate.enabled &&
    !gate.excludeAreas.includes(fm.area) &&
    (gate.areas.length === 0 || gate.areas.includes(fm.area));
  if (score < c.decline)
    return { score, parts, decision: "declined", reason: `${summary}, below ${c.decline}` };
  if (score >= accept && inScope)
    return { score, parts, decision: "merged", reason: `${summary}, at least ${accept}` };
  return {
    score,
    parts,
    decision: "review",
    reason:
      score >= accept
        ? `${summary}; area ${fm.area} always gets a reviewer`
        : `${summary}, between ${c.decline} and ${accept}`,
  };
}

/** The breakdown as one readable line, e.g. "+50 review comment… · +14 from dana (senior)". */
export const explainConfidence = (c: Confidence) =>
  c.parts.map((p) => `${p.delta > 0 ? "+" : ""}${p.delta} ${p.label}`).join(" · ");
