import type { Entry } from "./entry.ts";
import { error, type Issue } from "./issues.ts";
import { locate } from "./layout.ts";
import { countTokens } from "./tokens.ts";

/** The `core` area always exists and holds team-wide entries. */
export const CORE_AREA = "core";

export interface CheckContext {
  /** Path of the entry file relative to the KB root, e.g. `knowledge/core/my-rule.md`. */
  path: string;
  /** Area names from the config's `areas` key (a one-repo KB). */
  areas: readonly string[];
  /** A multi-repo KB: each repo's short name → its area names. Omitted for a one-repo KB. */
  repos?: Readonly<Record<string, readonly string[]>>;
  autoMergeThreshold: number;
  /** Member ids from the config's `team`. When omitted, member references are not checked. */
  members?: readonly string[];
  /** The computed score, when known; the threshold check uses it instead of the stored one. */
  score?: number;
}

/** Checks one parsed entry against its location and the KB config. Pure; no I/O. */
export function checkEntry(entry: Entry, ctx: CheckContext): Issue[] {
  const fm = entry.frontmatter;
  const file = ctx.path;
  const issues: Issue[] = [];
  const parts = ctx.path.replaceAll("\\", "/").split("/");
  const filename = parts.at(-1) ?? "";

  if (filename !== `${fm.id}.md`) {
    issues.push(
      error("path.filename", `filename must be "${fm.id}.md" to match id`, { path: "id", file }),
    );
  }
  const where = locate(ctx.path, ctx.repos ? Object.keys(ctx.repos) : undefined);
  const known = ctx.repos && where?.repo ? (ctx.repos[where.repo] ?? []) : ctx.areas;
  if (!where || where.kind !== "rule") {
    issues.push(
      error(
        "path.root",
        ctx.repos
          ? `entry must live at knowledge/core/${fm.id}.md or knowledge/<repo>/<area>/${fm.id}.md, with <repo> one of repos (${Object.keys(ctx.repos).join(", ")})`
          : `entry must live at knowledge/<area>/${fm.id}.md`,
        { file },
      ),
    );
  } else if (where.area !== fm.area) {
    issues.push(
      error("path.folder", `folder "${where.area}" does not match area "${fm.area}"`, {
        path: "area",
        file,
      }),
    );
  }

  if (fm.area !== CORE_AREA && !known.includes(fm.area)) {
    issues.push(
      error(
        "area.unknown",
        `area "${fm.area}" is not in the ${where?.repo ? `areas of repo ${where.repo}` : "config's areas"} (${[CORE_AREA, ...known].join(", ")})`,
        { path: "area", file },
      ),
    );
  }

  if (ctx.members) {
    const refs: [string, string | undefined][] = [
      ["owner", fm.owner],
      ["source.author", fm.source.author],
      ["approvedBy", fm.approvedBy],
      ...(fm.flags ?? []).map((f, i): [string, string] => [`flags.${i}.by`, f.by]),
    ];
    for (const [path, member] of refs) {
      if (member !== undefined && !ctx.members.includes(member)) {
        issues.push(
          error("member.unknown", `${path}: "${member}" is not a team member`, { path, file }),
        );
      }
    }
  }

  // No approval field is required: a rule is accepted by the merge that put it on the base
  // branch, decided by the daily run's confidence score or a reviewer (branch protection makes
  // sure nothing else can merge).

  const tokens = countTokens(entry.body);
  if (fm.tokens !== tokens) {
    issues.push({
      code: "tokens.mismatch",
      severity: "warning",
      message: `tokens is ${fm.tokens}, body counts ${tokens}; run with --fix to update`,
      path: "tokens",
      file,
      fix: { field: "tokens", value: tokens },
    });
  }

  return issues;
}
