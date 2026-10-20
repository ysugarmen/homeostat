import { CORE_AREA, checkEntry } from "./check.ts";
import { CONFIG_FILE, type Config, parseConfig } from "./config.ts";
import { detectConflicts } from "./conflicts.ts";
import { type Doc, isDocPath, parseDoc } from "./doc.ts";
import { type Entry, parseEntry } from "./entry.ts";
import { error, hasErrors, type Issue } from "./issues.ts";
import { areasOf, locate, repoNames } from "./layout.ts";
import { RISK_ADVICE, scanRisk } from "./risk.ts";
import { score } from "./score.ts";
import { findEmails, scanSecrets } from "./secrets.ts";
import { GENERAL_TOPIC, isTopicFile, parseTopicFile, rulePath, topicsFor } from "./topics.ts";

/** A knowledge base as file contents keyed by path relative to its root, `/`-separated. */
export type KbFiles = Record<string, string>;

export interface ValidatedEntry {
  /** The rule's path as a one-rule file, `…/<area>/<id>.md`, real or (in a topic file) virtual. */
  path: string;
  entry: Entry;
  /** The topic file it lives in, when it is grouped; `path` is then virtual. */
  file?: string;
  topic?: string;
}

export interface ValidatedDoc {
  path: string;
  doc: Doc;
}

export interface ValidateResult {
  /** True when there are no errors; warnings (all fixable) do not fail validation. */
  ok: boolean;
  issues: Issue[];
  entries: ValidatedEntry[];
  /** Knowledge documents (`knowledge/<area>/docs/`), validated separately from rules. */
  docs: ValidatedDoc[];
  config?: Config;
}

/** Every `.md` file under `knowledge/` is an entry, so misplaced entries are caught too. */
const isEntryPath = (path: string) =>
  path.startsWith("knowledge/") && path.endsWith(".md") && !isDocPath(path);

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
    if (isTopicFile(files[path] ?? "")) {
      issues.push(...topicFileIssues(path, files[path] ?? "", config, entries));
      continue;
    }
    const parsed = parseEntry(files[path] ?? "");
    issues.push(...parsed.issues.map((i) => ({ ...i, file: path })));
    issues.push(...contentIssues(path, files[path] ?? ""));
    if (!parsed.entry) continue;
    entries.push({ path, entry: parsed.entry });
    if (config) issues.push(...checkWithConfig(path, parsed.entry, config));
  }

  const docs: ValidatedDoc[] = [];
  for (const path of Object.keys(files).filter(isDocPath).sort()) {
    const text = files[path] ?? "";
    const parsed = parseDoc(text);
    issues.push(...parsed.issues.map((i) => ({ ...i, file: path })));
    issues.push(...contentIssues(path, text));
    if (!parsed.doc) continue;
    docs.push({ path, doc: parsed.doc });
    if (config) issues.push(...docConfigIssues(path, parsed.doc, config));
  }

  const pathOf = new Map<string, string[]>();
  for (const { path, file, entry } of entries) {
    pathOf.set(entry.frontmatter.id, [...(pathOf.get(entry.frontmatter.id) ?? []), file ?? path]);
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

  return { ok: !hasErrors(issues), issues, entries, docs, ...(config ? { config } : {}) };
}

/**
 * A topic file: its own structure, then each rule as if it were a one-rule file at its virtual
 * path. Issues point at the topic file, prefixed with the rule's #id.
 */
function topicFileIssues(
  path: string,
  text: string,
  config: Config | undefined,
  entries: ValidatedEntry[],
): Issue[] {
  const parsed = parseTopicFile(path, text);
  const issues: Issue[] = [...parsed.issues, ...contentIssues(path, text)];
  const repo = config?.repos ? locate(path, repoNames(config))?.repo : undefined;
  if (config && parsed.meta) {
    const topics = topicsFor(config, repo);
    const topic = parsed.meta.topic;
    if (!topics) {
      issues.push(
        error(
          "topic.unconfigured",
          `rules are grouped in topic files only when ${repo ? `repos.${repo}.topics` : "topics"} is set in homeostat.yaml`,
          { file: path },
        ),
      );
    } else if (topic !== GENERAL_TOPIC && !Object.hasOwn(topics, topic)) {
      issues.push(
        error(
          "topic.unknown",
          `topic "${topic}" is not in ${repo ? `repos.${repo}.topics` : "topics"} (${[GENERAL_TOPIC, ...Object.keys(topics)].join(", ")})`,
          { file: path, path: "topic" },
        ),
      );
    }
  }
  const ids = parsed.sections.map((s) => s.id);
  if (ids.some((id, i) => i > 0 && id.localeCompare(ids[i - 1] ?? "") < 0)) {
    issues.push({
      code: "topic.unsorted",
      severity: "warning",
      message:
        "rules are not sorted by id; keeping them sorted lets separate PRs change separate lines",
      file: path,
    });
  }
  const seen = new Set<string>();
  for (const section of parsed.sections) {
    const at = (i: Issue): Issue => ({ ...i, file: path, message: `#${section.id}: ${i.message}` });
    if (seen.has(section.id)) {
      issues.push(
        error("topic.duplicate", `#${section.id}: listed twice in this file`, { file: path }),
      );
      continue;
    }
    seen.add(section.id);
    if (section.text === undefined) continue;
    const virtual = rulePath(path, section.id);
    const entry = parseEntry(section.text);
    issues.push(...entry.issues.map(at));
    if (!entry.entry) continue;
    entries.push({
      path: virtual,
      entry: entry.entry,
      file: path,
      topic: parsed.meta?.topic ?? "",
    });
    if (config) issues.push(...checkWithConfig(virtual, entry.entry, config).map(at));
  }
  return issues;
}

function checkWithConfig(path: string, entry: Entry, config: Config): Issue[] {
  const fm = entry.frontmatter;
  const computed = score(fm, { config }).score;
  const issues = checkEntry(entry, {
    path,
    areas: Object.keys(config.areas),
    ...(config.repos ? { repos: repoAreas(config) } : {}),
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

/** A document's area, owner and folder must agree with the config; its text is scanned like a rule's. */
function docConfigIssues(path: string, doc: Doc, config: Config): Issue[] {
  const fm = doc.frontmatter;
  const issues: Issue[] = [];
  const where = locate(path, config.repos ? repoNames(config) : undefined);
  if (!where) {
    issues.push(
      error(
        "doc.path",
        config.repos
          ? "a document lives at knowledge/core/docs/ or knowledge/<repo>/<area>/docs/, with <repo> one of repos"
          : "a document lives at knowledge/<area>/docs/",
        { file: path },
      ),
    );
  } else {
    if (!areasOf(config, where.repo).includes(fm.area)) {
      issues.push(
        error(
          "doc.area.unknown",
          `area "${fm.area}" is not in ${where.repo ? `repos.${where.repo}.areas` : "homeostat.yaml"}`,
          { file: path, path: "area" },
        ),
      );
    }
    if (where.area !== fm.area) {
      const folder = where.repo ? `${where.repo}/${where.area}` : where.area;
      issues.push(
        error(
          "doc.area.folder",
          `area is "${fm.area}" but the file is under knowledge/${folder}/`,
          {
            file: path,
            path: "area",
          },
        ),
      );
    }
  }
  for (const [field, id] of [
    ["owner", fm.owner],
    ["riskReviewedBy", fm.riskReviewedBy],
  ] as const) {
    if (id !== undefined && !config.team.members.some((m) => m.id === id)) {
      issues.push(
        error(`doc.${field}.unknown`, `${field}: ${id} is not a team member`, {
          file: path,
          path: field,
        }),
      );
    }
  }
  if (fm.riskReviewedBy === undefined) {
    const host = config.sources ? [HOST_DOMAINS[config.sources.host]] : [];
    const text = [doc.intro, ...doc.sections.map((s) => `${s.heading}\n${s.body}`)].join("\n");
    // Drafted sections are also checked for bare hostnames: a model copies them from manifests.
    const drafted = doc.sections
      .filter((s) => s.provenance?.source === "seed" || s.provenance?.source === "bootstrap")
      .map((s) => `${s.heading}\n${s.body}`)
      .join("\n");
    const allowedDomains = [...host, ...config.security.allowedDomains];
    const findings = [
      ...scanRisk(text, { allowedDomains }),
      ...scanRisk(drafted, { allowedDomains, bareHosts: true }).filter(
        (f) => f.kind === "unlisted-host",
      ),
    ];
    for (const f of findings) {
      issues.push(
        error(
          `risk.${f.kind}`,
          `"${f.excerpt}" ${RISK_ADVICE[f.kind]}; if the document is safe, a member sets riskReviewedBy after reading it`,
          { file: path },
        ),
      );
    }
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
  if (known) {
    // In a multi-repo KB, a rule learned from a repo's PR is that repo's (or shared).
    const folder = config.repos ? locate(path, repoNames(config))?.repo : undefined;
    const from = Object.entries(config.repos ?? {}).find(
      ([, r]) => r.source.toLowerCase() === repo,
    )?.[0];
    if (!folder || folder === from) return [];
    return [
      error(
        "source.url.repo-folder",
        `source.url is a PR in ${from ? `repo ${from}` : repo}, but the rule is under knowledge/${folder}/; move it to knowledge/${from ?? "core"}/ or to knowledge/core/ if it holds in every repo`,
        { file: path, path: "source.url" },
      ),
    ];
  }
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

/** Each repo's area names, for the path checks of a multi-repo KB. */
const repoAreas = (config: Config): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(config.repos ?? {}).map(([repo, r]) => [repo, Object.keys(r.areas)]),
  );
