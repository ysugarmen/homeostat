import { parseDocument } from "yaml";
import { z } from "zod";
import { CORE_AREA } from "./check.ts";
import type { Asker } from "./claude.ts";
import { CONFIG_FILE, type Config, parseConfig } from "./config.ts";
import { isDocPath } from "./doc.ts";
import { parseEntry } from "./entry.ts";
import { error, type Issue } from "./issues.ts";
import { locate } from "./layout.ts";
import { remoteRepo } from "./repo-detect.ts";
import { foldRules, GENERAL_TOPIC, isTopicFile } from "./topics.ts";
import { type KbFiles, validate } from "./validate.ts";

/** How a one-repo KB becomes a multi-repo one. */
export interface MigrationPlan {
  /** Each repo by short name → its source, owner/name. */
  repos: Record<string, string>;
  /** Each old area, core included → the repo it moves to; undefined keeps it shared (core only). */
  areas: Record<string, string | undefined>;
  /**
   * Optional topics, by repo short name ("" for the shared rules): the topic list, and which
   * rule goes in which. Rules not assigned go to general.
   */
  topics?: Record<string, { topics: Record<string, string>; assign: Record<string, string> }>;
}

export interface MigrationResult {
  /** Files to write (null to delete), config included. */
  files: Record<string, string | null>;
  /** Moves done, as old → new path. */
  moved: [string, string][];
  /** Problems in the migrated KB, from validate; empty when it is green. */
  issues: Issue[];
  notes: string[];
}

/**
 * Moves a one-repo KB to the multi-repo layout: every rule and document from
 * `knowledge/<area>/` to `knowledge/<repo>/<area>/` (or `knowledge/core/` when shared), the
 * config's areas under repos.<name>.areas, member, team and team-only areas repo-qualified,
 * and `migrated:` recorded for developers' syncs. A rule learned from a repo's PR goes to that
 * repo. With topics, rules are folded into topic files. Pure; the CLI writes the result.
 */
export function migrateKb(files: KbFiles, config: Config, plan: MigrationPlan): MigrationResult {
  const notes: string[] = [];
  const out: Record<string, string | null> = {};
  const moved: [string, string][] = [];
  const sourceToRepo = new Map(
    Object.entries(plan.repos).map(([short, source]) => [source.toLowerCase(), short]),
  );

  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith("knowledge/") || !path.endsWith(".md")) continue;
    const where = locate(path);
    if (!where) {
      notes.push(`${path}: not in the one-repo layout, left where it is`);
      continue;
    }
    let repo = plan.areas[where.area];
    // A rule learned from a repo's PR belongs to that repo, whatever its area maps to.
    if (where.kind === "rule" && !isTopicFile(text)) {
      const url = parseEntry(text).entry?.frontmatter.source.url;
      const from = url ? sourceToRepo.get(remoteRepo(url) ?? "") : undefined;
      if (from && from !== repo) {
        if (where.area === CORE_AREA || plan.areas[where.area] === undefined) repo = from;
        else notes.push(`${path}: learned in ${from}, but area ${where.area} moves to ${repo}`);
      }
    }
    const folder = repo ? `${repo}/${where.area}` : CORE_AREA;
    const rest = path.slice(`knowledge/${where.area}/`.length);
    const target = `knowledge/${folder}/${rest}`;
    if (target === path) continue;
    out[path] = null;
    out[target] = text;
    moved.push([path, target]);
  }

  const configText = rewriteConfig(files[CONFIG_FILE] ?? "", config, plan);
  out[CONFIG_FILE] = configText;

  // Topics: each rule gets its topic, then foldRules writes the topic files.
  let result: Record<string, string | null> = out;
  if (plan.topics) {
    const next = parseConfig(configText).config;
    if (!next) throw new Error("the migrated homeostat.yaml does not parse");
    const view: KbFiles = { ...files };
    for (const [p, t] of Object.entries(out)) {
      if (t === null) delete view[p];
      else view[p] = t;
    }
    const changes: { path: string; text: string | null; topic: string }[] = [];
    for (const [p, t] of Object.entries(view)) {
      if (!p.startsWith("knowledge/") || isDocPath(p) || !p.endsWith(".md") || isTopicFile(t))
        continue;
      const id = parseEntry(t).entry?.frontmatter.id;
      if (!id) continue;
      const repo =
        p.split("/")[1] === CORE_AREA && p.split("/").length === 3 ? "" : (p.split("/")[1] ?? "");
      const scope = plan.topics[repo];
      if (!scope) continue;
      changes.push({ path: p, text: t, topic: scope.assign[id] ?? GENERAL_TOPIC });
    }
    const folded = foldRules(view, changes, next);
    result = { ...out };
    for (const [p, t] of Object.entries(folded)) result[p] = t;
  }

  const after: KbFiles = { ...files };
  for (const [p, t] of Object.entries(result)) {
    if (t === null) delete after[p];
    else after[p] = t;
  }
  const issues = validate(after).issues.filter((i) => i.severity === "error");
  return { files: result, moved, issues, notes };
}

/** The config, rewritten in place so comments and order survive. */
function rewriteConfig(text: string, config: Config, plan: MigrationPlan): string {
  const doc = parseDocument(text);
  const qualify = (area: string) => {
    const repo = plan.areas[area];
    return repo ? `${repo}/${area}` : area;
  };
  const repos: Record<string, unknown> = {};
  for (const [short, source] of Object.entries(plan.repos)) {
    const areas = Object.fromEntries(
      Object.entries(config.areas).filter(([a]) => plan.areas[a] === short),
    );
    const topics = plan.topics?.[short]?.topics;
    repos[short] = {
      source,
      ...(Object.keys(areas).length ? { areas } : {}),
      ...(topics && Object.keys(topics).length ? { topics } : {}),
    };
  }
  if (doc.hasIn(["areas"])) doc.deleteIn(["areas"]);
  doc.setIn(["repos"], doc.createNode(repos));
  if (doc.hasIn(["sources", "repos"])) doc.deleteIn(["sources", "repos"]);
  const shared = plan.topics?.[""]?.topics;
  if (shared && Object.keys(shared).length) doc.setIn(["topics"], doc.createNode(shared));
  config.team.members.forEach((m, i) => {
    if (m.areas.length)
      doc.setIn(["team", "members", i, "areas"], doc.createNode(m.areas.map(qualify)));
  });
  for (const [name, team] of Object.entries(config.teams)) {
    if (team.areas.length)
      doc.setIn(["teams", name, "areas"], doc.createNode(team.areas.map(qualify)));
  }
  if (config.security.teamOnlyAreas.length) {
    doc.setIn(
      ["security", "teamOnlyAreas"],
      doc.createNode(config.security.teamOnlyAreas.map(qualify)),
    );
  }
  doc.setIn(
    ["migrated"],
    doc.createNode(
      Object.fromEntries(Object.keys(plan.areas).map((a) => [a, plan.areas[a] ?? "shared"])),
    ),
  );
  return doc.toString();
}

/** A one-repo KB path's new place, by the recorded `migrated:` map; undefined if unknown. */
export function migratedPath(
  path: string,
  config: Pick<Config, "migrated" | "repos">,
): string | undefined {
  if (!config.migrated) return undefined;
  const where = locate(path);
  if (!where) return undefined;
  const to = config.migrated[where.area];
  if (!to) return undefined;
  const rest = path.slice(`knowledge/${where.area}/`.length);
  return to === "shared"
    ? `knowledge/${CORE_AREA}/${rest}`
    : `knowledge/${to}/${where.area}/${rest}`;
}

export const migrateError = (message: string) => error("migrate", message, { file: CONFIG_FILE });

/** Proposes a repo's topic list from its rules, and which rule goes where. */
export interface TopicProposer {
  propose(
    rules: readonly { id: string; title: string; rule: string }[],
  ): Promise<{ topics: Record<string, string>; assign: Record<string, string> }>;
}

export const TOPICS_SYSTEM = `You organise a software team's knowledge base of coding rules that AI coding agents follow. Group the rules into topics, so each topic becomes one file that people browse and review. Propose between 3 and 12 topics: each a short lowercase-hyphenated name (like migrations, lazy-imports, helm-charts, testing) and a one-line description of what belongs there, specific enough that a new rule can be sorted by it. Put each rule in exactly one topic, by its id. Prefer topics by subject (what the code does), not by team or file. A rule that fits no topic can be left out; it goes to general.`;

const topicsSchema = z.object({
  topics: z.array(
    z.object({ name: z.string(), description: z.string(), rules: z.array(z.string()) }),
  ),
});

export class ClaudeTopicProposer implements TopicProposer {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  async propose(rules: readonly { id: string; title: string; rule: string }[]) {
    if (rules.length === 0) return { topics: {}, assign: {} };
    const prompt = rules.map((r) => `- ${r.id}: ${r.title}. ${r.rule}`).join("\n");
    const out = await this.ask(TOPICS_SYSTEM, `<rules>\n${prompt}\n</rules>`, topicsSchema);
    const known = new Set(rules.map((r) => r.id));
    const topics: Record<string, string> = {};
    const assign: Record<string, string> = {};
    for (const t of out?.topics ?? []) {
      const name = t.name.trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name === GENERAL_TOPIC) continue;
      topics[name] = t.description.trim();
      for (const id of t.rules) if (known.has(id) && !assign[id]) assign[id] = name;
    }
    return { topics, assign };
  }
}
