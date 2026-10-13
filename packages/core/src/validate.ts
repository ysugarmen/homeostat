import { checkEntry } from "./check.ts";
import { CONFIG_FILE, type Config, parseConfig } from "./config.ts";
import { detectConflicts } from "./conflicts.ts";
import { type Entry, parseEntry } from "./entry.ts";
import { error, hasErrors, type Issue } from "./issues.ts";
import { score } from "./score.ts";

/** A knowledge base as file contents keyed by path relative to its root, `/`-separated. */
export type KbFiles = Record<string, string>;

export interface ValidatedEntry {
  path: string;
  entry: Entry;
}

export interface ValidateResult {
  /** True when there are no errors; warnings (all fixable) do not fail validation. */
  ok: boolean;
  issues: Issue[];
  entries: ValidatedEntry[];
  config?: Config;
}

/** Every `.md` file under `knowledge/` is an entry, so misplaced entries are caught too. */
const isEntryPath = (path: string) => path.startsWith("knowledge/") && path.endsWith(".md");

/**
 * Validates a whole knowledge base: config, every entry, scores, and cross-entry conflicts.
 * Pure: the caller reads the files (see the CLI) and decides what to do with fixable warnings.
 */
export function validate(files: KbFiles): ValidateResult {
  const issues: Issue[] = [];

  let config: Config | undefined;
  const configText = files[CONFIG_FILE];
  if (configText === undefined) {
    issues.push(error("config.missing", `no ${CONFIG_FILE} at the KB root`, { file: CONFIG_FILE }));
  } else {
    const parsed = parseConfig(configText);
    config = parsed.config;
    issues.push(...parsed.issues);
  }

  const entries: ValidatedEntry[] = [];
  for (const path of Object.keys(files).filter(isEntryPath).sort()) {
    const parsed = parseEntry(files[path] ?? "");
    issues.push(...parsed.issues.map((i) => ({ ...i, file: path })));
    if (!parsed.entry) continue;
    entries.push({ path, entry: parsed.entry });
    if (config) issues.push(...checkWithConfig(path, parsed.entry, config));
  }

  const pathOf = new Map<string, string[]>();
  for (const { path, entry } of entries) {
    pathOf.set(entry.frontmatter.id, [...(pathOf.get(entry.frontmatter.id) ?? []), path]);
  }
  for (const c of detectConflicts(entries.map((e) => e.entry.frontmatter))) {
    const [first] = c.ids;
    const paths = (first && pathOf.get(first)) || [undefined];
    for (const file of c.kind === "duplicate-id" ? paths : paths.slice(0, 1)) {
      issues.push({
        code: `conflict.${c.kind}`,
        severity: c.severity,
        message: c.message,
        ...(file ? { file } : {}),
      });
    }
  }

  return { ok: !hasErrors(issues), issues, entries, ...(config ? { config } : {}) };
}

function checkWithConfig(path: string, entry: Entry, config: Config): Issue[] {
  const fm = entry.frontmatter;
  const computed = score(fm, { config }).score;
  const issues = checkEntry(entry, {
    path,
    areas: Object.keys(config.areas),
    autoMergeThreshold: config.scoring.autoMergeThreshold,
    members: config.team.members.map((m) => m.id),
    score: computed,
  });
  if (fm.score !== computed) {
    issues.push({
      code: "score.mismatch",
      severity: "warning",
      message: `score is ${fm.score}, computed ${computed}; scores are computed, run with --fix to update`,
      path: "score",
      file: path,
      fix: { field: "score", value: computed },
    });
  }
  return issues;
}
