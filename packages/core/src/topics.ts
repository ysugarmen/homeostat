import { parseDocument, stringify } from "yaml";
import type { Config } from "./config.ts";
import { type Entry, formatEntry, parseEntry } from "./entry.ts";
import { error, type Issue } from "./issues.ts";
import { isMultiRepo, locate, repoNames } from "./layout.ts";

/**
 * Topic files: several rules in one file, `knowledge/<area>/<topic>.md` (or
 * `knowledge/<repo>/<area>/<topic>.md`), one `##` section per rule. Everything else in Homeostat
 * works on single rules: a section is turned into the same text a one-rule file has, at a
 * virtual path `…/<area>/<id>.md`, so parsing, validation and scoring stay one code path.
 *
 * ```markdown
 * ---
 * topic: migrations
 * title: Migrations
 * description: Alembic schema changes, backfills and their deploy order
 * ---
 *
 * ## Keep million-row backfills out of schema migrations {#keep-million-row-backfills}
 * <!-- homeostat
 * status: accepted
 * owner: sam
 * …
 * -->
 *
 * The rule.
 *
 * ### Why
 * The reason.
 * ```
 */

/** Where a rule goes when its topic is unknown. Always allowed. */
export const GENERAL_TOPIC = "general";

export interface TopicMeta {
  topic: string;
  title: string;
  description?: string;
}

export interface TopicSection {
  id: string;
  /** The section as written, heading included, trimmed. */
  raw: string;
  /** The rule as a one-rule file's text, for parseEntry; undefined when the section is broken. */
  text?: string;
  /** 1-based line of the section heading in the topic file. */
  line: number;
}

export interface ParsedTopicFile {
  meta?: TopicMeta;
  sections: TopicSection[];
  issues: Issue[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const HEADING = /^##\s+(.+?)\s*\{#([a-z0-9]+(?:-[a-z0-9]+)*)\}\s*$/;
const META = /^<!--\s*homeostat\s*\r?\n([\s\S]*?)\r?\n\s*-->\s*$/m;

/** Whether a file under knowledge/ is a topic file (frontmatter with `topic`, no `id`). */
export function isTopicFile(text: string): boolean {
  const fm = FRONTMATTER.exec(text)?.[1];
  if (fm === undefined) return false;
  return /^topic:/m.test(fm) && !/^id:/m.test(fm);
}

/** The virtual one-rule path of a rule in a topic file: `…/<area>/<id>.md`. */
export const rulePath = (topicFile: string, id: string): string =>
  `${topicFile.slice(0, topicFile.lastIndexOf("/"))}/${id}.md`;

/** The topic file a rule at virtual path `…/<area>/<id>.md` belongs to, for `topic`. */
export const topicFilePath = (path: string, topic: string): string =>
  `${path.slice(0, path.lastIndexOf("/"))}/${topic}.md`;

/** Splits a topic file into its sections; each becomes a one-rule text for parseEntry. */
export function parseTopicFile(path: string, text: string): ParsedTopicFile {
  const issues: Issue[] = [];
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return {
      sections: [],
      issues: [
        error("topic.frontmatter", "a topic file starts with a --- frontmatter block", {
          file: path,
        }),
      ],
    };
  }
  const head = parseDocument(match[1] ?? "").toJS() as Record<string, unknown> | null;
  const topic = typeof head?.topic === "string" ? head.topic : "";
  const fileTopic = path.slice(path.lastIndexOf("/") + 1, -3);
  if (topic !== fileTopic) {
    issues.push(
      error("topic.name", `topic: "${topic}" must match the file name "${fileTopic}"`, {
        file: path,
        path: "topic",
      }),
    );
  }
  const meta: TopicMeta = {
    topic: fileTopic,
    title: typeof head?.title === "string" && head.title ? head.title : titleOf(fileTopic),
    ...(typeof head?.description === "string" ? { description: head.description } : {}),
  };

  const body = match[2] ?? "";
  const offset = (match[1] ?? "").split("\n").length + 2;
  const lines = body.split(/\r?\n/);
  const starts: number[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence ? (line.trim().startsWith(fence) ? undefined : fence) : f[1];
    else if (!fence && /^##\s/.test(line)) starts.push(i);
  });
  if (lines.slice(0, starts[0] ?? lines.length).some((l) => l.trim())) {
    issues.push(
      error("topic.preamble", "text before the first rule; every rule is a ## section", {
        file: path,
      }),
    );
  }

  const area = locate(path, undefined)?.area ?? path.split("/").at(-2) ?? "";
  const sections: TopicSection[] = [];
  starts.forEach((start, k) => {
    const raw = lines
      .slice(start, starts[k + 1] ?? lines.length)
      .join("\n")
      .trim();
    const line = offset + start;
    const heading = HEADING.exec(lines[start] ?? "");
    if (!heading?.[1] || !heading[2]) {
      issues.push(
        error("topic.heading", `line ${line}: a rule heading is "## Title {#id}"`, { file: path }),
      );
      return;
    }
    const [, title, id] = heading;
    const rest = raw.slice((lines[start] ?? "").length).trim();
    const metaMatch = META.exec(rest);
    if (!metaMatch || rest.indexOf(metaMatch[0]) !== 0) {
      issues.push(
        error("topic.meta", `#${id}: the line after the heading is a <!-- homeostat … --> block`, {
          file: path,
        }),
      );
      sections.push({ id, raw, line });
      return;
    }
    const fields = parseDocument(metaMatch[1] ?? "").toJS() as Record<string, unknown> | null;
    const parts = splitBody(rest.slice(metaMatch[0].length).trim());
    const fm = {
      id,
      title,
      area: (fields?.area as string | undefined) ?? area,
      ...(fields ?? {}),
      topic: fileTopic,
    };
    sections.push({ id, raw, line, text: formatLoose(fm, entryBody(parts)) });
  });
  return { meta, sections, issues };
}

/** Writes one rule as a topic-file section. */
export function ruleSection(entry: Entry): string {
  const { id, title, area: _area, topic: _topic, ...rest } = entry.frontmatter;
  const parts = [
    `## ${title} {#${id}}`,
    `<!-- homeostat\n${stringify(rest).trim()}\n-->`,
    entry.sections.rule ?? "",
  ];
  if (entry.sections.why) parts.push(`### Why\n${entry.sections.why}`);
  if (entry.sections.example) parts.push(`### Example\n${entry.sections.example}`);
  return parts.join("\n\n");
}

/** A topic file from its meta and raw sections, the sections sorted by id. */
export function formatTopicFile(
  meta: TopicMeta,
  sections: readonly Pick<TopicSection, "id" | "raw">[],
): string {
  const head = stringify(
    {
      topic: meta.topic,
      title: meta.title,
      ...(meta.description ? { description: meta.description } : {}),
    },
    { lineWidth: 0 },
  );
  const body = [...sections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => s.raw.trim())
    .join("\n\n");
  return `---\n${head}---\n\n${body}\n`;
}

/** The topics a folder's rules may use, or undefined when the KB keeps one file per rule. */
export function topicsFor(
  config: Pick<Config, "topics" | "repos">,
  repo?: string,
): Record<string, string> | undefined {
  return repo ? config.repos?.[repo]?.topics : config.topics;
}

/** Whether the KB groups rules into topic files: any topics configured. */
export const usesTopics = (config: Pick<Config, "topics" | "repos">): boolean =>
  config.topics !== undefined ||
  Object.values(config.repos ?? {}).some((r) => r.topics !== undefined);

/**
 * Folds rule changes, given as one-rule texts at virtual paths (`…/<area>/<id>.md`, null to
 * remove), into the KB's files. Rules already in a topic file are updated there; new ones go to
 * `topic` (default general) when the KB uses topics, and stay one file per rule otherwise.
 * Returns the real files to write (null to delete).
 */
export function foldRules(
  files: Readonly<Record<string, string>>,
  changes: readonly { path: string; text: string | null; topic?: string }[],
  config: Pick<Config, "topics" | "repos">,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const current = (p: string) => (Object.hasOwn(out, p) ? out[p] : files[p]);
  const repos = isMultiRepo(config) ? repoNames(config) : undefined;
  for (const change of changes) {
    const id = change.path.slice(change.path.lastIndexOf("/") + 1, -3);
    const dir = change.path.slice(0, change.path.lastIndexOf("/") + 1);
    const home = Object.keys({ ...files, ...out }).find((p) => {
      const t = current(p);
      return (
        p.startsWith(dir) &&
        !p.slice(dir.length).includes("/") &&
        t &&
        isTopicFile(t) &&
        parseTopicFile(p, t).sections.some((s) => s.id === id)
      );
    });
    const repo = locate(change.path, repos)?.repo;
    const topics = topicsFor(config, repo);
    const named = change.topic ?? (change.text ? topicOfText(change.text) : undefined);
    const target = named
      ? topicFilePath(change.path, named)
      : (home ??
        (topics && current(change.path) === undefined
          ? topicFilePath(change.path, GENERAL_TOPIC)
          : undefined));
    if (!target) {
      out[change.path] = change.text; // one file per rule
      continue;
    }
    if (home && home !== target)
      out[home] = withSection(home, current(home) ?? "", id, null, topics);
    if (current(change.path) !== undefined && !isTopicFile(current(change.path) ?? ""))
      out[change.path] = null;
    out[target] = withSection(target, current(target) ?? "", id, change.text, topics);
  }
  return out;
}

function withSection(
  path: string,
  text: string,
  id: string,
  ruleText: string | null,
  topics?: Record<string, string>,
): string | null {
  const parsed = text
    ? parseTopicFile(path, text)
    : { meta: undefined, sections: [] as TopicSection[] };
  const topic = path.slice(path.lastIndexOf("/") + 1, -3);
  const meta = parsed.meta ?? {
    topic,
    title: titleOf(topic),
    ...(topics?.[topic] ? { description: topics[topic] } : {}),
  };
  const sections = parsed.sections.filter((s) => s.id !== id);
  if (ruleText !== null) {
    const entry = parseEntry(ruleText).entry;
    if (entry) sections.push({ id, raw: ruleSection(entry), line: 0 });
  }
  return sections.length ? formatTopicFile(meta, sections) : null;
}

/**
 * Three-way merge of a topic file, section by section: a section changed on one side only takes
 * that side; changed differently on both is a conflict, and ours is kept. Lets the daily run and
 * `homeostat review merge` rebuild a topic file instead of leaving a git conflict.
 */
export function mergeTopicFile(
  path: string,
  base: string | undefined,
  ours: string,
  theirs: string,
): { text: string | null; conflicts: string[] } {
  const read = (t: string | undefined) => {
    const p = t ? parseTopicFile(path, t) : undefined;
    return { meta: p?.meta, map: new Map((p?.sections ?? []).map((s) => [s.id, s.raw])) };
  };
  const b = read(base);
  const o = read(ours);
  const t = read(theirs);
  const conflicts: string[] = [];
  const merged: Pick<TopicSection, "id" | "raw">[] = [];
  for (const id of new Set([...o.map.keys(), ...t.map.keys(), ...b.map.keys()])) {
    const [bv, ov, tv] = [b.map.get(id), o.map.get(id), t.map.get(id)];
    const pick = ov === tv ? ov : ov === bv ? tv : tv === bv ? ov : (conflicts.push(id), ov);
    if (pick !== undefined) merged.push({ id, raw: pick });
  }
  const sameMeta = JSON.stringify(o.meta) === JSON.stringify(b.meta);
  const meta = (sameMeta ? t.meta : o.meta) ?? o.meta ?? t.meta;
  return { text: meta && merged.length ? formatTopicFile(meta, merged) : null, conflicts };
}

const topicOfText = (text: string) =>
  /^topic:\s*([a-z0-9-]+)\s*$/m.exec(text.split(/\n---/)[0] ?? "")?.[1];

const titleOf = (topic: string) => topic.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Rule text, then `### Why` and `### Example`, outside code fences. */
function splitBody(text: string): { rule: string; why?: string; example?: string } {
  const out: Record<string, string[]> = { rule: [] };
  let key = "rule";
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence ? (line.trim().startsWith(fence) ? undefined : fence) : f[1];
    const h = !fence && !f ? /^###\s+(Why|Example)\s*$/i.exec(line) : null;
    if (h?.[1]) {
      key = h[1].toLowerCase();
      out[key] = [];
      continue;
    }
    out[key]?.push(line);
  }
  const get = (k: string) => out[k]?.join("\n").trim();
  return {
    rule: get("rule") ?? "",
    ...(get("why") ? { why: get("why") } : {}),
    ...(get("example") ? { example: get("example") } : {}),
  };
}

const entryBody = (p: { rule: string; why?: string; example?: string }) =>
  [
    `## Rule\n${p.rule}`,
    ...(p.why !== undefined ? [`## Why\n${p.why}`] : []),
    ...(p.example ? [`## Example\n${p.example}`] : []),
  ].join("\n\n");

/** Like formatEntry, without requiring a valid frontmatter: parseEntry reports what is wrong. */
function formatLoose(fm: Record<string, unknown>, body: string): string {
  return formatEntry(fm as never, body);
}

/**
 * A rule's one-rule text at its path `…/<area>/<id>.md`: the file itself, or its section in a
 * topic file of the same folder. Undefined when the rule is in neither.
 */
export function findRule(
  files: Readonly<Record<string, string>>,
  path: string,
): string | undefined {
  if (files[path] !== undefined) return files[path];
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  const id = path.slice(dir.length, -3);
  for (const [p, text] of Object.entries(files)) {
    if (!p.startsWith(dir) || p.slice(dir.length).includes("/") || !isTopicFile(text)) continue;
    const hit = parseTopicFile(p, text).sections.find((s) => s.id === id);
    if (hit) return hit.text;
  }
  return undefined;
}

/**
 * A developer's view: their pending one-rule files over the KB. A pending version of a rule
 * that lives in a topic file replaces its section, so the rule is not seen twice.
 */
export function overlayPending(
  files: Readonly<Record<string, string>>,
  pending: Readonly<Record<string, string>>,
): Record<string, string> {
  const view: Record<string, string> = { ...files, ...pending };
  for (const path of Object.keys(pending)) {
    if (files[path] !== undefined) continue;
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const id = path.slice(dir.length, -3);
    for (const [p, text] of Object.entries(view)) {
      if (!p.startsWith(dir) || p.slice(dir.length).includes("/") || !isTopicFile(text)) continue;
      const parsed = parseTopicFile(p, text);
      if (!parsed.meta || !parsed.sections.some((s) => s.id === id)) continue;
      const rest = parsed.sections.filter((s) => s.id !== id);
      if (rest.length) view[p] = formatTopicFile(parsed.meta, rest);
      else delete view[p];
    }
  }
  return view;
}

const STOP = new Set([
  "about",
  "after",
  "before",
  "every",
  "from",
  "into",
  "never",
  "their",
  "these",
  "this",
  "that",
  "them",
  "with",
  "when",
  "what",
  "where",
  "which",
  "while",
  "your",
]);
const words = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((w) => w.length > 3 && !STOP.has(w)),
  );

/**
 * The topic a hand-written rule most likely belongs in, without a model: the topic whose name
 * and description share the most words with the rule's title and text. general when none does.
 */
export function matchTopic(topics: Readonly<Record<string, string>>, text: string): string {
  const have = words(text);
  let best = GENERAL_TOPIC;
  let score = 0;
  for (const [name, about] of Object.entries(topics)) {
    const nameWords = words(name.replace(/-/g, " "));
    const n =
      [...nameWords].filter((w) => have.has(w)).length * 2 +
      [...words(about)].filter((w) => have.has(w) && !nameWords.has(w)).length;
    if (n > score) [best, score] = [name, n];
  }
  return best;
}
