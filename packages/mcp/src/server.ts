import {
  type Config,
  detectConflicts,
  type Entry,
  type KbFiles,
  renderContext,
  score,
  searchEntries,
  selectEntries,
  validate,
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
  now(): Date;
}

const INSTRUCTIONS = `Homeostat holds your team's reviewed coding rules, learned from accepted code-review feedback. Before changing code, call context with the files you will touch (or search for a topic) and follow the rules it returns. When the user teaches you a team convention, save it with learn. If a rule is wrong, flag it. explain says why a rule exists.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t.slice(0, MAX_CHARS) }] });
const fail = (t: string) => ({ ...text(t), isError: true });

const asList = (v: unknown) => (typeof v === "string" ? [v] : v);

/** Accepts the argument spellings agents reach for, then validates. */
const schemas = {
  search: z.object({
    query: z.string().min(1),
    area: z.string().optional(),
    path: z.string().optional(),
    limit: z.int().min(1).max(20).optional(),
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
};

function normalizeArgs(tool: ToolName, raw: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = ARG_ALIASES[key] ?? key;
    if (args[name] === undefined) args[name] = value;
  }
  if (tool === "context") {
    if (args.paths === undefined && typeof args.path === "string") args.paths = args.path;
    args.paths = asList(args.paths);
    delete args.path;
  }
  if (tool === "learn" && args.scope !== undefined) args.scope = asList(args.scope);
  return args;
}

/** The tools agents see. Descriptions stay under 200 characters (execution plan 3.1). */
export const TOOLS: { name: ToolName; description: string }[] = [
  {
    name: "context",
    description:
      "Team rules that apply to the given files, best first, within a token budget. Call before editing code.",
  },
  {
    name: "search",
    description:
      "Search the team's accepted coding rules by topic or keyword, optionally limited to an area or a file path.",
  },
  {
    name: "explain",
    description:
      "Why a rule exists: its source review comment, score breakdown, owner, conflicts and when it was last confirmed.",
  },
  {
    name: "learn",
    description:
      "Save a lesson the user taught you as a candidate team rule (title, one-paragraph rule, why). A reviewer accepts it.",
  },
  {
    name: "flag",
    description:
      "Report that a rule is wrong or outdated, with the reason. It loses score and goes back to review.",
  },
  {
    name: "report",
    description:
      "Knowledge base health over recent days: entries by status, new, flagged, disputed, stale, duplicates, injections.",
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

function describeEntry(e: Entry, config: Config): string {
  const fm = e.frontmatter;
  const reasons = score(fm, { config }).reasons.map(
    (r) => `${r.delta > 0 ? "+" : ""}${r.delta} ${r.note}`,
  );
  const lines = [
    `# ${fm.title} (${fm.id})`,
    `Status: ${fm.status} · score ${fm.score} (${reasons.join(", ") || "no signals"}) · owner ${fm.owner} · area ${fm.area}`,
    `Applies to: ${fm.scope.join(", ")}`,
    `Source: ${fm.source.type} by ${fm.source.author}${fm.source.url ? ` — ${fm.source.url}` : ""}${fm.source.changedCode ? " (code changed after the comment)" : ""}`,
    `Created ${fm.created}, last confirmed ${fm.lastConfirmed}`,
    ...(fm.conflictsWith?.length ? [`Conflicts with: ${fm.conflictsWith.join(", ")}`] : []),
    ...(fm.supersedes ? [`Supersedes: ${fm.supersedes}`] : []),
    ...(fm.flags ?? []).map((f) => `Flagged by ${f.by} on ${f.date}: ${f.reason}`),
    "",
    `Rule: ${e.sections.rule ?? ""}`,
    "",
    `Why: ${e.sections.why ?? ""}`,
    ...(e.sections.example ? ["", e.sections.example] : []),
  ];
  return lines.join("\n");
}

const hitLine = (e: Entry) =>
  `- ${e.frontmatter.id}: ${e.frontmatter.title} [${e.frontmatter.area}, score ${e.frontmatter.score}]\n  ${e.sections.rule ?? ""}`;

/** Builds the Homeostat MCP server. Transport-agnostic: the CLI connects it to stdio. */
export function createServer(deps: McpDeps, version = "0.0.0"): Server {
  const server = new Server(
    { name: "homeostat", version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
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
    deps.log({ ts, type: "mcp-call", tool });

    const parsed = schemas[tool].safeParse(normalizeArgs(tool, rawArgs));
    if (!parsed.success) {
      const problems = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "arguments"}: ${i.message}`,
      );
      return fail(`Invalid arguments for ${tool}: ${problems.join("; ")}`);
    }
    const args = parsed.data as Record<string, unknown>;

    const kb = validate(deps.readKb());
    const config = kb.config;
    if (!config) {
      return fail(
        "No usable knowledge base: homeostat.yaml is missing or invalid. Point Homeostat at your KB checkout with the plugin's kb_dir setting or HOMEOSTAT_DIR.",
      );
    }
    const entries = kb.entries.map((e) => e.entry);

    try {
      switch (tool) {
        case "search": {
          const a = args as z.infer<typeof schemas.search>;
          const hits = searchEntries(entries, a.query, {
            ...(a.area ? { area: a.area } : {}),
            ...(a.path ? { path: a.path } : {}),
            limit: a.limit ?? 5,
          });
          return text(
            hits.length
              ? hits.map((h) => hitLine(h.entry)).join("\n")
              : `No accepted rules match "${a.query}". The team may not have one yet; if you learn one, save it with learn.`,
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
            return fail(`No entry with id "${a.id}".${hint}`);
          }
          return text(describeEntry(e, config));
        }
        case "learn":
          return text(await deps.learn(args as unknown as LearnInput));
        case "flag": {
          const a = args as z.infer<typeof schemas.flag>;
          if (!entries.some((x) => x.frontmatter.id === a.id))
            return fail(`No entry with id "${a.id}".`);
          return text(await deps.flag(a.id, a.reason));
        }
        case "report":
          return text(report(entries, config, (args as { days?: number }).days ?? 7, deps));
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
  });

  return server;
}

function report(entries: Entry[], config: Config, days: number, deps: McpDeps): string {
  const now = deps.now();
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const staleBefore = new Date(now.getTime() - config.agents.deepDive.staleAfterDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const byStatus = new Map<string, number>();
  for (const e of entries)
    byStatus.set(e.frontmatter.status, (byStatus.get(e.frontmatter.status) ?? 0) + 1);
  const fresh = entries.filter((e) => e.frontmatter.created >= since);
  const flagged = entries.filter((e) => e.frontmatter.flags?.length);
  const stale = entries.filter(
    (e) => e.frontmatter.status === "accepted" && e.frontmatter.lastConfirmed < staleBefore,
  );
  const duplicates = detectConflicts(entries.map((e) => e.frontmatter)).filter(
    (c) => c.kind === "possible-duplicate",
  );
  const events = (deps.events?.() ?? []).filter(
    (e) => typeof e.ts === "string" && e.ts.slice(0, 10) >= since,
  );
  const injections = events.filter((e) => e.type === "injection").length;
  const unknown = events.filter(
    (e) => e.type === "mcp-unknown-tool" || e.type === "mcp-alias",
  ).length;

  return [
    `Knowledge base, last ${days} days (since ${since}):`,
    `- Entries: ${entries.length} (${[...byStatus].map(([s, n]) => `${n} ${s}`).join(", ") || "none"})`,
    `- New: ${fresh.length}${fresh.length ? ` (${fresh.map((e) => e.frontmatter.id).join(", ")})` : ""}`,
    `- Flagged: ${flagged.length}${flagged.length ? ` (${flagged.map((e) => e.frontmatter.id).join(", ")})` : ""}`,
    `- Disputed: ${byStatus.get("disputed") ?? 0}`,
    `- Stale (not confirmed in ${config.agents.deepDive.staleAfterDays} days): ${stale.length}`,
    `- Possible duplicates: ${duplicates.length}`,
    `- Rule injections into sessions: ${injections}`,
    `- Guessed tool names logged: ${unknown}`,
  ].join("\n");
}
