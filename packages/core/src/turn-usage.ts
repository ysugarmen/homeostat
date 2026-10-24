import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseCredits, RETRIEVAL_TOOLS } from "./guide.ts";

/**
 * Per-turn usage of the KB, read from a Claude Code session transcript: which Homeostat MCP tools
 * the agent called in each user turn, and which rules or sections it credited with the
 * `> From Homeostat (…)` line. Only tool names, ids and counts come out; prompt and reply text are
 * read here and never kept. The approach follows vectorize-io/hindsight's usage log (MIT).
 *
 * The transcript is JSON lines. Verified against Claude Code transcripts: a user turn starts at a
 * `type: "user"` line whose `message.content` is a string or holds a `text` block (tool results
 * come back as user lines holding only `tool_result` blocks); `isMeta`, `isSidechain` and
 * `isCompactSummary` lines are not turns. An assistant message is split over several lines (one
 * per content block, sharing `message.id`): `text`, `thinking`, and `tool_use` with `name`. MCP
 * tools are named `mcp__<server>__<tool>`, the plugin's server `plugin_homeostat_homeostat`.
 */

export interface TurnUsage {
  /** 1-based number of the user turn in the session. */
  turn: number;
  /** When the turn's prompt was written, from the transcript; absent in older formats. */
  at?: string;
  /** Homeostat MCP tools called during the turn, in order (names only). */
  calls: string[];
  /** Whether any call handed knowledge back (context, search, explain, docs, read). */
  retrieved: boolean;
  /** Ids from credit lines, lowercased and deduplicated, before checking them against the KB. */
  credits: string[];
  /** Credit lines in the reply, and credited items that were not id-shaped. */
  creditLines: number;
  otherCredits: number;
  /** Byte offset of the line that opened the turn, so a later read can start there. */
  offset: number;
}

/** `search` for `mcp__plugin_homeostat_homeostat__search` (or any server named after homeostat). */
export function homeostatTool(name: string): string | undefined {
  const m = /^mcp__(.+)__([A-Za-z0-9_-]+)$/.exec(name);
  if (!m || !/homeostat/i.test(m[1] ?? "")) return undefined;
  return m[2]?.toLowerCase();
}

interface Line {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

const blocks = (content: unknown): Record<string, unknown>[] =>
  Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
    : [];

function opensTurn(line: Line): boolean {
  if (line.type !== "user" || line.isMeta === true || line.isSidechain === true) return false;
  if (line.isCompactSummary === true) return false;
  const content = line.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  return blocks(content).some((b) => b.type === "text");
}

/**
 * Splits transcript lines into user turns. `lines` carry their byte offsets; `firstTurn` is the
 * number to give the first turn found (when reading from the middle of a file). Lines before the
 * first turn belong to none. Malformed lines are skipped.
 */
export function summarizeTurns(
  lines: readonly { text: string; offset: number }[],
  firstTurn = 1,
): TurnUsage[] {
  const out: TurnUsage[] = [];
  const replies = new Map<TurnUsage, string[]>();
  for (const { text, offset } of lines) {
    if (!text.trim()) continue;
    let line: Line;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) continue;
      line = parsed as Line;
    } catch {
      continue; // a line still being written
    }
    if (opensTurn(line)) {
      const turn: TurnUsage = {
        turn: firstTurn + out.length,
        ...(typeof line.timestamp === "string" ? { at: line.timestamp } : {}),
        calls: [],
        retrieved: false,
        credits: [],
        creditLines: 0,
        otherCredits: 0,
        offset,
      };
      out.push(turn);
      replies.set(turn, []);
      continue;
    }
    const current = out.at(-1);
    if (!current || line.type !== "assistant" || line.isSidechain === true) continue;
    for (const b of blocks(line.message?.content)) {
      if (b.type === "tool_use" && typeof b.name === "string") {
        const tool = homeostatTool(b.name);
        if (tool) current.calls.push(tool);
      } else if (b.type === "text" && typeof b.text === "string") {
        replies.get(current)?.push(b.text);
      }
    }
  }
  for (const [turn, texts] of replies) {
    turn.retrieved = turn.calls.some((c) => RETRIEVAL_TOOLS.has(c));
    addCredits(turn, texts.join("\n"));
  }
  return out;
}

/** Adds the credits in `text` (a reply, or the Stop hook's `last_assistant_message`) to a turn. */
export function addCredits(turn: TurnUsage, text: string) {
  const c = parseCredits(text);
  if (c.lines === 0) return;
  turn.credits = [...new Set([...turn.credits, ...c.ids])];
  turn.creditLines += c.lines;
  turn.otherCredits += c.other;
}

/**
 * The lines of `path` from byte `offset` to the end, each with its own offset. An offset past the
 * end (the file was rewritten) reads from the start. A missing file is no lines.
 */
export function readLinesFrom(
  path: string,
  offset: number,
): { lines: { text: string; offset: number }[]; from: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], from: 0 };
  }
  const from = offset > size ? 0 : offset;
  const buf = Buffer.alloc(size - from);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, from + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  const lines: { text: string; offset: number }[] = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > start) lines.push({ text: buf.toString("utf8", start, i), offset: from + start });
      start = i + 1;
    }
  }
  return { lines, from };
}
