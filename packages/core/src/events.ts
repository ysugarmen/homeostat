import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE } from "./config.ts";

// node:sqlite prints an ExperimentalWarning on some Node versions; hooks must stay quiet.
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes("SQLite")) return;
  (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = emitWarning;

/** The KB's local, git-ignored event store: hooks, MCP calls, captures and agent runs. */
export const EVENTS_DB = ".homeostat/events.db";
/** The earlier append-only log, imported once into the database. */
export const LEGACY_EVENTS = ".homeostat/events.jsonl";

export type Event = Record<string, unknown> & { ts: string; type: string };

export interface EventQuery {
  /** ISO timestamp or date; events at or after it. */
  since?: string;
  types?: readonly string[];
  limit?: number;
}

type Db = InstanceType<typeof DatabaseSync>;
const open = new Map<string, Db>();

function db(kbRoot: string): Db {
  const cached = open.get(kbRoot);
  if (cached) return cached;
  mkdirSync(join(kbRoot, ".homeostat"), { recursive: true });
  const d = new DatabaseSync(join(kbRoot, EVENTS_DB));
  d.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
    CREATE INDEX IF NOT EXISTS events_type ON events (type, ts);
  `);
  importLegacy(kbRoot, d);
  open.set(kbRoot, d);
  return d;
}

function importLegacy(kbRoot: string, d: Db) {
  const legacy = join(kbRoot, LEGACY_EVENTS);
  if (!existsSync(legacy)) return;
  const insert = d.prepare("INSERT INTO events (ts, type, data) VALUES (?, ?, ?)");
  d.exec("BEGIN");
  for (const line of readFileSync(legacy, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as Event;
      if (typeof e.ts === "string" && typeof e.type === "string") insert.run(e.ts, e.type, line);
    } catch {
      // A torn last line from an interrupted write.
    }
  }
  d.exec("COMMIT");
  renameSync(legacy, `${legacy}.imported`);
}

export function logEvent(kbRoot: string, event: Record<string, unknown>) {
  const e = { ts: new Date().toISOString(), ...event } as Event;
  db(kbRoot)
    .prepare("INSERT INTO events (ts, type, data) VALUES (?, ?, ?)")
    .run(String(e.ts), String(e.type), JSON.stringify(e));
}

export function readEvents(kbRoot: string, q: EventQuery = {}): Event[] {
  if (!existsSync(join(kbRoot, EVENTS_DB)) && !existsSync(join(kbRoot, LEGACY_EVENTS))) return [];
  const where: string[] = [];
  const params: string[] = [];
  if (q.since) {
    where.push("ts >= ?");
    params.push(q.since);
  }
  if (q.types?.length) {
    where.push(`type IN (${q.types.map(() => "?").join(", ")})`);
    params.push(...q.types);
  }
  const sql = `SELECT data FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts, id${q.limit ? ` LIMIT ${Math.floor(q.limit)}` : ""}`;
  return (
    db(kbRoot)
      .prepare(sql)
      .all(...params) as { data: string }[]
  ).map((r) => JSON.parse(r.data) as Event);
}

/** What happened in one event, without its time and type. */
export function describeEvent(e: Event): string {
  const { type, ...rest } = e;
  return (() => {
    switch (type) {
      case "injection": {
        const entries = (rest.entries as { id: string }[] | undefined) ?? [];
        const via = rest.source === "mcp" ? "MCP" : `hook${rest.source ? ` (${rest.source})` : ""}`;
        return `${entries.length} rule${entries.length === 1 ? "" : "s"} (${rest.tokens ?? "?"} tokens) via ${via}${entries.length ? `: ${entries.map((x) => x.id).join(", ")}` : ""}`;
      }
      case "mcp-call":
        return `tool ${rest.tool}`;
      case "mcp-alias":
        return `guessed "${rest.name}" → ${rest.resolved}`;
      case "mcp-unknown-tool":
        return `unknown tool "${rest.name}"`;
      case "handoff-requested":
        return `asked ${rest.member} for a handoff note after ${rest.edits} edits`;
      case "entry-created":
        return `${rest.id} by ${rest.author} (${rest.sourceType}${rest.branch ? `, on ${rest.branch}` : ""})`;
      case "entry-flagged":
        return `${rest.id} by ${rest.by}: ${rest.reason}`;
      case "auto-merged":
        return `${(rest.entries as string[] | undefined)?.join(", ") ?? ""} in ${rest.url}`;
      case "agent-run":
        return `${rest.agent} ${rest.ok ? "ok" : "failed"}: ${rest.summary ?? ""}`;
      default:
        return JSON.stringify(rest);
    }
  })();
}

/** One readable line per event, for `homeostat events`. */
export function formatEvent(e: Event): string {
  return `${String(e.ts).replace("T", " ").slice(0, 19)}  ${e.type.padEnd(18)} ${describeEvent(e)}`;
}

/** Records a failed agent run, when `dir` is a KB (so liveness shows the failure). */
export function logFailure(dir: string, agent: string, reason: string) {
  const root = resolve(dir);
  if (!existsSync(join(root, CONFIG_FILE))) return;
  logEvent(root, { type: "agent-run", agent, ok: false, summary: reason });
}
