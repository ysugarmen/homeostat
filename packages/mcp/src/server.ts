import {
  CREDIT_LABEL,
  detectRepo,
  docCovers,
  docRef,
  type Entry,
  explainEntry,
  hitLine,
  inRepo,
  isRejectedDecision,
  type KbFiles,
  kbReport,
  renderContext,
  searchEntries,
  searchSections,
  selectEntries,
  snippet,
  TRIGGER_MOMENTS,
  VERSION,
  validate,
  visibleTo,
} from "@homeostat/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Claude Code's limit on context from one source; kept for tool results too. */
const MAX_CHARS = 10_000;

export interface LearnInput {
  title: string;
  rule: string;
  why: string;
  area?: string;
  scope?: string[];
}

/** What the server needs from its host; the CLI supplies the git-backed writes. */
export interface McpDeps {
  /** The KB as it is now; called on every request so edits show up without a restart. */
  readKb(): KbFiles;
  /** Saves a candidate entry; returns a one-line summary for the agent. */
  learn(input: LearnInput): Promise<string>;
  /** Records a "this is wrong" flag; returns a one-line summary. */
  flag(id: string, reason: string): Promise<string>;
  /** Appends an event to the KB's log. */
  log(event: Record<string, unknown>): void;
  /** Recent events, newest last, for `report`. */
  events?(): Record<string, unknown>[];
  /** The member this session belongs to, for team-only areas; unknown hides them. */
  member?(): string | undefined;
  /** The session's folder: Claude Code starts the server there, and sets CLAUDE_PROJECT_DIR. */
  checkout?(): string;
  now(): Date;
}

const WRITE_TOOLS = new Set(["learn", "flag"]);

/**
 * Names the moments to look things up (they move agents far more than a category does; see
 * core's guide.ts) and the credit line. Mentions learn and flag only when this KB offers them, so
 * agents never look for a hidden tool.
 */
const instructions = (writes: boolean) =>
  `Homeostat holds your team's knowledge base: reviewed coding rules, learned from code review, from developers and from the code, and the team's reference documents. Before changing code, call context with the files you will touch, or search for a subject, and follow what it returns. Look things up first when ${TRIGGER_MOMENTS.join("; ")}. search covers rules and document sections; docs lists documents and read returns one section; explain says why a rule exists. When something you used came from here, start that part of your reply with "> ${CREDIT_LABEL} (<rule-id or area/topic#section>)". ${
    writes
      ? "When the user teaches you a team convention, save it with learn. If a rule is wrong, flag it."
      : "Saving through MCP is off for this team: when the user teaches you a team convention, use the /homeostat:learn skill or the homeostat learn command; to dispute a rule, homeostat flag <id> --reason."
  }`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t.slice(0, MAX_CHARS) }] });
const fail = (t: string) => ({ ...text(t), isError: true });
type ToolResult = ReturnType<typeof text> & { isError?: boolean };

const asList = (v: unknown) => (typeof v === "string" ? [v] : v);

/** Search hits by default: one search should answer, so agents need fewer of them. */
const SEARCH_LIMIT = 10;
const CREDIT_HINT = `Credit what you use: > ${CREDIT_LABEL} (<id>).`;

/** Accepts the argument spellings agents reach for, then validates. */
const schemas = {
  search: z.object({
    query: z.string().min(1),
    area: z.string().optional(),
    path: z.string().optional(),
    limit: z.int().min(1).max(30).optional(),
  }),
  context: z.object({
    paths: z.array(z.string()).min(1),
    tokenBudget: z.int().positive().optional(),
  }),
  explain: z.object({ id: z.string().min(1) }),
  learn: z.object({
    title: z.string().min(1),
    rule: z.string().min(1),
    why: z.string().min(1),
    area: z.string().optional(),
    scope: z.array(z.string()).optional(),
  }),
  flag: z.object({ id: z.string().min(1), reason: z.string().min(1) }),
  report: z.object({ days: z.int().positive().max(365).optional() }),
  list: z.object({ area: z.string().optional() }),
  docs: z.object({ area: z.string().optional(), path: z.string().optional() }),
  read: z.object({ doc: z.string().min(1), section: z.string().optional() }),
};
type ToolName = keyof typeof schemas;

const ARG_ALIASES: Record<string, string> = {
  q: "query",
  text: "query",
  topic: "query",
  entry_id: "id",
  entryId: "id",
  entry: "id",
  name: "id",
  files: "paths",
  file: "paths",
  path_list: "paths",
  token_budget: "tokenBudget",
  budget: "tokenBudget",
  lesson: "rule",
  description: "why",
  window: "days",
  document: "doc",
  section_id: "section",
};

/**
 * A JSON array or object sent as a string (`"[\"a.ts\"]"`), as some clients do, parsed back;
 * numbers sent as strings are read as numbers. Anything else is left for validation to judge.
 * Adapted from vectorize-io/hindsight's tolerant tool arguments (MIT).
 */
function coerce(value: unknown, field: z.ZodType | undefined): unknown {
  if (typeof value !== "string" || !field) return value;
  const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
  if (inner instanceof z.ZodArray || inner instanceof z.ZodObject) {
    const t = value.trim();
    if (/^[[{]/.test(t)) {
      try {
        return JSON.parse(t);
      } catch {
        return value;
      }
    }
  }
  if (inner instanceof z.ZodNumber && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return value;
}

/**
 * Accepts the spellings and shapes agents send: aliases become the real names, string-encoded
 * JSON is parsed, and arguments the tool does not take (an agent's `explanation`, `reasoning`)
 * are dropped rather than failing the call.
 */
function normalizeArgs(tool: ToolName, raw: Record<string, unknown>): Record<string, unknown> {
  const shape = schemas[tool].shape as Record<string, z.ZodType>;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = ARG_ALIASES[key] ?? key;
    // context takes `path` as a spelling of `paths`; every tool else keeps only its own fields.
    if (!(name in shape) && !(tool === "context" && name === "path")) continue;
    if (args[name] === undefined) args[name] = coerce(value, shape[name]);
  }
  if (tool === "context") {
    if (args.paths === undefined && typeof args.path === "string") args.paths = args.path;
    args.paths = asList(args.paths);
    delete args.path;
  }
  if (tool === "learn" && args.scope !== undefined) args.scope = asList(args.scope);
  return args;
}

type Annotations = {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
};
/** Reads touch nothing; Homeostat never reaches beyond the KB, so no tool is open-world. */
const READ_ONLY: Annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

/**
 * The tools agents see. Each description says when to call it, since a tool registered without
 * its moment is mostly left alone. Under 200 characters each (execution plan 3.1).
 */
export const TOOLS: { name: ToolName; description: string; annotations: Annotations }[] = [
  {
    name: "context",
    description:
      "Team rules for the files you are about to change, best first. Call before editing, writing a test or committing.",
    annotations: READ_ONLY,
  },
  {
    name: "search",
    description:
      "Search team rules and document sections by subject; ~10 hits with snippets. Call first on a bug report, new code, a why question or before a commit.",
    annotations: READ_ONLY,
  },
  {
    name: "explain",
    description:
      "Why a rule exists: its source review comment, score breakdown, owner, conflicts and when it was last confirmed.",
    annotations: READ_ONLY,
  },
  {
    name: "learn",
    description:
      "Save a lesson the user taught you as a candidate team rule (title, one-paragraph rule, why). A reviewer accepts it.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "flag",
    description:
      "Report that a rule is wrong or outdated, with the reason. It loses score and goes back to review.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: "report",
    description:
      "Knowledge base health over recent days: entries by status, new, flagged, disputed, stale, duplicates, injections.",
    annotations: READ_ONLY,
  },
  {
    name: "docs",
    description:
      "List the team's reference documents (architecture, contracts, migrations, domain guides) and their section ids, optionally for an area or file.",
    annotations: READ_ONLY,
  },
  {
    name: "read",
    description:
      'Read one section of a team document (or all of it): doc is "<area>/<topic>", section a section id, as search or docs show them.',
    annotations: READ_ONLY,
  },
];

/** Names agents guess, mapped to the real tool. Accepted silently and logged as desire paths. */
const TOOL_ALIASES: Record<string, ToolName> = {
  get_context: "context",
  rules_for: "context",
  get_rules: "context",
  rules: "context",
  rules_for_files: "context",
  find: "search",
  query: "search",
  lookup: "search",
  search_rules: "search",
  find_rules: "search",
  get: "explain",
  get_entry: "explain",
  get_rule: "explain",
  show: "explain",
  describe: "explain",
  why: "explain",
  add: "learn",
  add_rule: "learn",
  remember: "learn",
  save: "learn",
  create_entry: "learn",
  teach: "learn",
  dispute: "flag",
  report_wrong: "flag",
  flag_entry: "flag",
  stats: "report",
  status: "report",
  health: "report",
  list: "list",
  list_rules: "list",
  documents: "docs",
  list_docs: "docs",
  list_documents: "docs",
  read_doc: "read",
  read_document: "read",
  get_doc: "read",
  get_document: "read",
  open: "read",
  list_entries: "list",
  all: "list",
};

/** Lowercase, `-` to `_`, and strip prefixes agents add (`homeostat_search`, `kb.search`). */
const canonical = (name: string) =>
  name
    .toLowerCase()
    .replace(/[-.\s]+/g, "_")
    .replace(/^(mcp__)?(homeostat|kb|knowledge|team)_+/, "");

function resolveTool(name: string): { tool?: ToolName; alias: boolean } {
  const c = canonical(name);
  if (TOOLS.some((t) => t.name === c)) return { tool: c as ToolName, alias: c !== name };
  if (TOOL_ALIASES[c]) return { tool: TOOL_ALIASES[c], alias: true };
  return { alias: false };
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return (d[a.length] as number[])[b.length] ?? 0;
}

/** FNV-1a over every path and its text: equal for an unchanged KB, cheap next to parsing it. */
function fingerprint(files: Readonly<Record<string, string>>): string {
  let h = 0x811c9dc5;
  for (const path of Object.keys(files).sort()) {
    const text = `${path}\0${files[path] ?? ""}\0`;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return `${Object.keys(files).length}:${(h >>> 0).toString(16)}`;
}

/** Builds the Homeostat MCP server. Transport-agnostic: the CLI connects it to stdio. */
export function createServer(deps: McpDeps, version = VERSION): Server {
  // The KB is parsed once and reused until a file changes: a session's calls come in bursts, and
  // parsing a few hundred rules on each was most of every call's time. Only loaded, not checked:
  // CI validates what is on the base branch.
  let cached: { key: string; kb: ReturnType<typeof validate> } | undefined;
  const loadKb = () => {
    const files = deps.readKb();
    const key = fingerprint(files);
    if (cached?.key !== key) cached = { key, kb: validate(files, { checks: false }) };
    return cached.kb;
  };
  let repoFor: { key: string; repo: string | undefined } | undefined;
  const sessionRepo = (
    checkout: string,
    config: NonNullable<ReturnType<typeof validate>["config"]>,
  ) => {
    const key = `${checkout}\0${JSON.stringify(config.repos ?? null)}`;
    if (repoFor?.key !== key) repoFor = { key, repo: detectRepo(checkout, config) };
    return repoFor.repo;
  };
  const startWrites = loadKb().config?.security.mcpWrites === true;
  const server = new Server(
    { name: "homeostat", version },
    { capabilities: { tools: {} }, instructions: instructions(startWrites) },
  );

  // Writes are off unless the KB enables them, and capped per session when on (security T7):
  // an agent steered by text it read must not be able to push a stream of branches.
  let writes = 0;
  const writesOn = () => loadKb().config?.security.mcpWrites === true;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.filter((t) => writesOn() || !WRITE_TOOLS.has(t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      annotations: t.annotations,
      inputSchema: z.toJSONSchema(schemas[t.name]) as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { tool, alias } = resolveTool(name);
    const ts = deps.now().toISOString();

    if (!tool) {
      deps.log({ ts, type: "mcp-unknown-tool", name, args: Object.keys(rawArgs) });
      const closest = [...TOOLS]
        .sort((a, b) => distance(canonical(name), a.name) - distance(canonical(name), b.name))
        .at(0)?.name;
      return fail(
        `Unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(", ")}.${closest ? ` Did you mean ${closest}?` : ""}`,
      );
    }
    if (alias) deps.log({ ts, type: "mcp-alias", name, resolved: tool });
    // Logged after the call, with its wall time and whether it answered or failed.
    const started = performance.now();
    const dispatch = async (): Promise<ToolResult> => {
      const parsed = schemas[tool].safeParse(normalizeArgs(tool, rawArgs));
      if (!parsed.success) {
        const problems = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "arguments"}: ${i.message}`,
        );
        return fail(`Invalid arguments for ${tool}: ${problems.join("; ")}`);
      }
      const args = parsed.data as Record<string, unknown>;

      const kb = loadKb();
      const config = kb.config;
      if (!config) {
        return fail(
          "No usable knowledge base: homeostat.yaml is missing or invalid. Point Homeostat at your KB checkout with the plugin's kb_dir setting or HOMEOSTAT_DIR.",
        );
      }
      // A multi-repo KB: the shared rules plus the session's repo; none of the other repos'. The
      // session's folder and remote don't change, so the answer is kept while the repos do too.
      const repo = deps.checkout ? sessionRepo(deps.checkout(), config) : undefined;
      const entries = visibleTo(
        inRepo(kb.entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
        config,
        deps.member?.(),
      );
      const docs = visibleTo(
        inRepo(kb.docs, config, repo).map((d) => ({ ...d, frontmatter: d.doc.frontmatter })),
        config,
        deps.member?.(),
      );
      if (WRITE_TOOLS.has(tool)) {
        if (!config.security.mcpWrites) {
          return fail(
            `Saving through MCP is off for this knowledge base (security.mcpWrites). Tell the user what you would ${tool}; they can run /homeostat:${tool === "learn" ? "learn" : "review"} or homeostat ${tool}.`,
          );
        }
        if (writes >= config.security.mcpWriteLimit) {
          return fail(
            `This session has used its ${config.security.mcpWriteLimit} MCP writes (security.mcpWriteLimit). Tell the user what else you would save.`,
          );
        }
        writes++;
      }

      try {
        switch (tool) {
          case "search": {
            const a = args as z.infer<typeof schemas.search>;
            const limit = a.limit ?? SEARCH_LIMIT;
            const rules = searchEntries(entries, a.query, {
              ...(a.area ? { area: a.area } : {}),
              ...(a.path ? { path: a.path } : {}),
              limit,
            });
            const sections = searchSections(
              docs
                .filter(
                  ({ doc }) =>
                    (!a.area || doc.frontmatter.area === a.area) &&
                    (!a.path || docCovers(doc, a.path)),
                )
                .flatMap(({ path, doc }) =>
                  doc.sections.map((s) => ({
                    doc: docRef(path),
                    title: doc.frontmatter.title,
                    id: s.id,
                    heading: s.heading,
                    body: s.body,
                  })),
                ),
              a.query,
              { limit },
            );
            // Rules and sections are ranked apart, so each list's scores are scaled to its best
            // before they are merged into one list of at most `limit`.
            const top = (xs: { score: number }[]) => Math.max(...xs.map((x) => x.score), 1e-9);
            const merged = [
              ...rules.map((h) => ({
                rank: h.score / top(rules),
                line: isRejectedDecision(h.entry.frontmatter)
                  ? hitLine(h.entry)
                  : `- ${h.entry.frontmatter.id} (rule, ${h.entry.frontmatter.area}): ${h.entry.frontmatter.title}\n  ${snippet(h.entry.sections.rule ?? "", a.query, 200)}`,
              })),
              ...sections.map((h) => ({
                rank: h.score / top(sections),
                line: `- ${h.section.doc}#${h.section.id} (document section): ${h.section.heading}\n  ${snippet(h.section.body, a.query)}`,
              })),
            ]
              .sort((x, y) => y.rank - x.rank)
              .slice(0, limit);
            // A miss is an answer, not an error: the agent carries on.
            return text(
              merged.length
                ? `${merged.map((m) => m.line).join("\n")}\n\nFull text: explain <rule id>, or read {"doc": "<area>/<topic>", "section": "<id>"}. ${CREDIT_HINT}`
                : `No team rules or document sections match "${a.query}". The team may not have written this down yet; carry on without it.`,
            );
          }
          case "context": {
            const a = args as z.infer<typeof schemas.context>;
            const selection = selectEntries(entries, {
              paths: a.paths,
              tokenBudget: a.tokenBudget ?? config.distribution.tokenBudget,
              maxChars: MAX_CHARS,
            });
            deps.log({
              ts,
              type: "injection",
              source: "mcp",
              ...(repo ? { repo } : {}),
              entries: selection.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
              tokens: selection.tokens,
            });
            return text(renderContext(selection) || "No team rules apply to these files.");
          }
          case "explain": {
            const a = args as z.infer<typeof schemas.explain>;
            const e = entries.find((x) => x.frontmatter.id === a.id);
            if (!e) {
              const hits = searchEntries(entries, a.id.replace(/-/g, " "), { limit: 3 });
              const hint = hits.length
                ? ` Closest: ${hits.map((h) => h.entry.frontmatter.id).join(", ")}.`
                : "";
              // An expected miss: a normal answer the agent can act on, not a tool error.
              return text(`No rule with id "${a.id}".${hint}`);
            }
            return text(explainEntry(e, config));
          }
          case "learn":
            return text(await deps.learn(args as unknown as LearnInput));
          case "flag": {
            const a = args as z.infer<typeof schemas.flag>;
            if (!entries.some((x) => x.frontmatter.id === a.id))
              return fail(`No entry with id "${a.id}".`);
            return text(await deps.flag(a.id, a.reason));
          }
          case "docs": {
            const a = args as z.infer<typeof schemas.docs>;
            const shown = docs.filter(
              ({ doc }) =>
                (!a.area || doc.frontmatter.area === a.area) && (!a.path || docCovers(doc, a.path)),
            );
            return text(
              shown.length
                ? shown
                    .map(
                      ({ path, doc }) =>
                        `- ${docRef(path)}: ${doc.frontmatter.title} [${doc.frontmatter.scope.join(", ")}]\n  sections: ${doc.sections
                          .filter((s) => s.id)
                          .map((s) => `${s.id} (${s.heading})`)
                          .join(", ")}`,
                    )
                    .join("\n")
                : "No team documents match. The team may not have written one for this area yet.",
            );
          }
          case "read": {
            const a = args as z.infer<typeof schemas.read>;
            // `area/topic#section`, as search hits and credits write it, names the section too.
            const [docPart = a.doc, hashSection] = a.doc.split("#");
            const wanted = a.section ?? hashSection;
            const ref = docPart
              .replace(/^knowledge\//, "")
              .replace(/\/docs\//, "/")
              .replace(/\.md$/, "");
            const found = docs.find((d) => docRef(d.path) === ref);
            // Misses are answers, not errors: they say what exists so the next call lands.
            if (!found) {
              return text(
                `No document "${a.doc}". Documents: ${docs.map((d) => docRef(d.path)).join(", ") || "none"}.`,
              );
            }
            const { doc } = found;
            const section = wanted ? doc.sections.find((s) => s.id === wanted) : undefined;
            if (wanted && !section) {
              return text(
                `No section "${wanted}" in ${ref}. Sections: ${doc.sections.map((s) => s.id).join(", ")}.`,
              );
            }
            deps.log({
              ts,
              type: "doc-read",
              doc: ref,
              ...(section ? { section: section.id } : {}),
            });
            const source = (s: (typeof doc.sections)[number]) =>
              s.provenance
                ? `(source: ${s.provenance.source}${s.provenance.updated ? `, ${s.provenance.updated}` : ""}${s.provenance.url ? `, ${s.provenance.url}` : ""})`
                : "";
            const render = (s: (typeof doc.sections)[number]) =>
              `## ${s.heading} {#${s.id}}\n${source(s)}\n${s.body}`.replace(/\n\n+/g, "\n\n");
            if (section) return text(`# ${doc.frontmatter.title} (${ref})\n\n${render(section)}`);
            // A whole document: each section once, as many as fit, then the ids of the rest, so
            // nothing is cut mid-section and nothing needs reading twice.
            let out = [`# ${doc.frontmatter.title} (${ref})`, doc.intro]
              .filter(Boolean)
              .join("\n\n");
            const rest: string[] = [];
            for (const s of doc.sections) {
              const next = `${out}\n\n${render(s)}`;
              if (rest.length || next.length > MAX_CHARS - 300) rest.push(s.id);
              else out = next;
            }
            return text(
              rest.length ? `${out}\n\nNot shown, read by section: ${rest.join(", ")}.` : out,
            );
          }
          case "report":
            return text(
              kbReport(entries, config, {
                days: (args as { days?: number }).days ?? 7,
                now: deps.now(),
                events: deps.events?.() ?? [],
              }),
            );
          case "list": {
            const a = args as z.infer<typeof schemas.list>;
            const accepted = entries.filter(
              (e) =>
                e.frontmatter.status === "accepted" && (!a.area || e.frontmatter.area === a.area),
            );
            return text(
              accepted
                .map((e) => `- ${e.frontmatter.id}: ${e.frontmatter.title} [${e.frontmatter.area}]`)
                .join("\n") || "No accepted rules yet.",
            );
          }
        }
      } catch (e) {
        return fail(`${tool} failed: ${(e as Error).message}`);
      }
    };
    const result = await dispatch();
    deps.log({
      ts,
      type: "mcp-call",
      tool,
      ms: Math.round(performance.now() - started),
      ok: result.isError !== true,
    });
    return result;
  });

  return server;
}
