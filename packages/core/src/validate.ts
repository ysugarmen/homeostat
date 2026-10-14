import { checkEntry } from "./check.ts";
import { CONFIG_FILE, type Config, parseConfig } from "./config.ts";
import { detectConflicts } from "./conflicts.ts";
import { type Entry, parseEntry } from "./entry.ts";
import { error, hasErrors, type Issue } from "./issues.ts";
import { RISK_ADVICE, scanRisk } from "./risk.ts";
import { score } from "./score.ts";
import { findEmails, scanSecrets } from "./secrets.ts";

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
    issues.push(...contentIssues(path, files[path] ?? ""));
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
  issues.push(...riskIssues(path, entry, config), ...provenanceIssues(path, entry, config));
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

export const HOST_DOMAINS = { github: "github.com", bitbucket: "bitbucket.org" } as const;

/**
 * Risky instructions in the title or body are errors until a member signs the entry off with
 * `riskReviewedBy`: every merged rule reaches every session, so a rule is a prompt (security T1).
 */
function riskIssues(path: string, entry: Entry, config: Config): Issue[] {
  const fm = entry.frontmatter;
  const host = config.sources ? [HOST_DOMAINS[config.sources.host]] : [];
  const findings = scanRisk(`${fm.title}\n${entry.body}`, {
    allowedDomains: [...host, ...config.security.allowedDomains],
  });
  if (fm.riskReviewedBy !== undefined) {
    if (config.team.members.some((m) => m.id === fm.riskReviewedBy)) return [];
    return [
      error("risk.reviewer.unknown", `riskReviewedBy: ${fm.riskReviewedBy} is not a team member`, {
        file: path,
        path: "riskReviewedBy",
      }),
    ];
  }
  return findings.map((f) =>
    error(
      `risk.${f.kind}`,
      `"${f.excerpt}" ${RISK_ADVICE[f.kind]}; if the entry is safe, a member sets riskReviewedBy after reading it`,
      { file: path },
    ),
  );
}

/** A pr-feedback entry must point at a PR in one of the repos the curator reads. */
function provenanceIssues(path: string, entry: Entry, config: Config): Issue[] {
  const { source } = entry.frontmatter;
  const sources = config.sources;
  if (source.type !== "pr-feedback" || !source.url || !sources || sources.repos.length === 0) {
    return [];
  }
  const url = new URL(source.url);
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  const repo = `${owner}/${name}`.toLowerCase();
  const known =
    url.hostname === HOST_DOMAINS[sources.host] &&
    sources.repos.some((r) => r.toLowerCase() === repo);
  if (known) return [];
  return [
    error(
      "source.url.unknown-repo",
      `source.url: ${source.url} is not a PR in sources.repos; pr-feedback entries must come from a repo the curator reads`,
      { file: path, path: "source.url" },
    ),
  ];
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Secrets are errors (the KB is shared and git keeps history); emails are warnings. */
function contentIssues(path: string, text: string): Issue[] {
  const issues: Issue[] = scanSecrets(text).map((f) =>
    error(
      "secret.found",
      `possible ${f.kind} (${f.preview}) on line ${lineOf(text, f.start)}: remove it and rotate it; the KB is shared and git keeps history`,
      { file: path },
    ),
  );
  for (const email of new Set(findEmails(text))) {
    issues.push({
      code: "pii.email",
      severity: "warning",
      message: `email address ${email}: refer to people by member id`,
      file: path,
    });
  }
  return issues;
}
