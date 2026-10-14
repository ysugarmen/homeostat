import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_ENV,
  CONFIG_FILE,
  CORE_AREA,
  type Config,
  logEvent,
  pruneEvents,
  readKbFiles,
  renderContext,
  selectEntries,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { git } from "./git.ts";
import { memberIdFrom } from "./init.ts";
import { touchedPaths } from "./touched.ts";

/** Claude Code's limit on SessionStart `additionalContext`. */
const MAX_CONTEXT_CHARS = 10_000;

export interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  transcript_path?: string;
  trigger?: string;
}

/** The KB checkout: the plugin's kb_dir option, then $HOMEOSTAT_DIR, then the session dir itself. */
export function findKb(env: Io["env"], cwd: string): string | undefined {
  // The plugin passes its kb_dir setting to hooks as CLAUDE_PLUGIN_OPTION_KB_DIR and to the MCP
  // server as HOMEOSTAT_KB_DIR_SETTING; both may be empty (or an unexpanded template) when unset.
  const setting = [env?.CLAUDE_PLUGIN_OPTION_KB_DIR, env?.HOMEOSTAT_KB_DIR_SETTING].find(
    (v) => v && !v.includes("${"),
  );
  const configured = setting || env?.HOMEOSTAT_DIR;
  if (configured) return resolve(configured);
  return existsSync(join(cwd, CONFIG_FILE)) ? cwd : undefined;
}

class HookSkip extends Error {}

async function sessionStart(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot) return;

  const { config, entries } = validate(readKbFiles(kbRoot));
  if (!config) throw new HookSkip("knowledge base config is invalid; run homeostat validate");
  pruneEvents(kbRoot, config.security.eventRetentionDays, io.now?.() ?? new Date());

  const paths = touchedPaths(cwd);
  const selection = selectEntries(
    entries.map((e) => e.entry),
    { paths, tokenBudget: config.distribution.tokenBudget, maxChars: MAX_CONTEXT_CHARS },
  );
  logEvent(kbRoot, {
    ts: (io.now?.() ?? new Date()).toISOString(),
    type: "injection",
    session: input.session_id,
    source: input.source,
    cwd,
    paths: paths.length,
    entries: selection.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
    dropped: selection.dropped,
    tokens: selection.tokens,
  });

  const context = renderContext(selection);
  if (!context) return;
  io.stdout(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    })}\n`,
  );
}

/** Tools whose use means the session changed files. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Counts file-changing tool uses in a Claude Code transcript (JSONL); unreadable lines are skipped. */
export function countEdits(transcriptPath: string | undefined): number {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  let edits = 0;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    try {
      const content = JSON.parse(line)?.message?.content;
      if (!Array.isArray(content)) continue;
      edits += content.filter((c) => c?.type === "tool_use" && EDIT_TOOLS.has(c.name)).length;
    } catch {
      // Not JSON; transcripts can end mid-line while being written.
    }
  }
  return edits;
}

interface HandoffState {
  asked?: boolean;
  /** Set by PreCompact: a long session, so ask at the next stop whatever the edit count. */
  compacted?: boolean;
}

const statePath = (kbRoot: string, session: string) =>
  join(kbRoot, ".homeostat/handoff", `${session.replace(/[^\w.-]/g, "_")}.json`);

function readState(kbRoot: string, session: string): HandoffState {
  try {
    return JSON.parse(readFileSync(statePath(kbRoot, session), "utf8"));
  } catch {
    return {};
  }
}

function writeState(kbRoot: string, session: string, state: HandoffState) {
  mkdirSync(join(kbRoot, ".homeostat/handoff"), { recursive: true });
  writeFileSync(statePath(kbRoot, session), JSON.stringify(state));
}

/** How the agent should invoke this same homeostat: the running bin when known, else `homeostat`. */
function homeostatCommand(): string {
  const bin = process.argv[1];
  return bin && /[\\/](homeostat|homeo)(\.js)?$/.test(bin) ? `node "${bin}"` : "homeostat";
}

function handoffInstructions(kbRoot: string, config: Config, member: string): string {
  const push = git(kbRoot, "remote", "get-url", "origin") ? " --push" : "";
  const areas = [CORE_AREA, ...Object.keys(config.areas)].join(", ");
  return `homeostat: before you finish, decide whether this session produced a lesson worth a handoff note for teammates' agents: a decision that was made, and what was tried and rejected. If not, reply only "No handoff note." and stop.

If yes, save exactly one note, without asking the user:

${homeostatCommand()} learn --dir "${kbRoot}" --source agent-handoff --branch candidates/${member}${push} --author ${member} --area <area> --title "<imperative title, at most 80 characters>" --rule "<what to do next time, at most 60 words>" --why "<what was tried and rejected, and why, at most 100 words>"

Areas: ${areas}. Then reply with one line saying the note was saved for review.`;
}

async function stop(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot || !input.session_id) return;
  const { config } = validate(readKbFiles(kbRoot));
  if (!config?.agents.handoff.enabled) return;

  const state = readState(kbRoot, input.session_id);
  if (state.asked) return;
  const edits = countEdits(input.transcript_path);
  if (edits < config.agents.handoff.minEdits && !state.compacted) return;

  const member = memberIdFrom(git(cwd, "config", "user.name"));
  if (!config.team.members.some((m) => m.id === member)) return;

  writeState(kbRoot, input.session_id, { ...state, asked: true });
  logEvent(kbRoot, {
    ts: (io.now?.() ?? new Date()).toISOString(),
    type: "handoff-requested",
    session: input.session_id,
    member,
    edits,
    compacted: state.compacted === true,
  });
  io.stdout(
    `${JSON.stringify({ decision: "block", reason: handoffInstructions(kbRoot, config, member) })}\n`,
  );
}

async function preCompact(input: HookInput, io: Io) {
  const kbRoot = findKb(io.env, input.cwd ?? process.cwd());
  if (!kbRoot || !input.session_id) return;
  writeState(kbRoot, input.session_id, { ...readState(kbRoot, input.session_id), compacted: true });
}

const HANDLERS: Record<string, (input: HookInput, io: Io) => Promise<void>> = {
  "session-start": sessionStart,
  stop,
  "pre-compact": preCompact,
};

export const HOOK_EVENTS = Object.keys(HANDLERS);

/**
 * `homeostat hook <event>`, called by the plugin's hooks with the event JSON on stdin. A hook must
 * never break a session, so every failure is reported on stderr and the exit code is still 0.
 */
export async function runHook(event: string, io: Io): Promise<number> {
  // An agent's own `claude -p` call must not inject rules or ask for handoff notes.
  if (io.env?.[AGENT_ENV]) return 0;
  try {
    const handler = HANDLERS[event];
    if (!handler) throw new HookSkip(`unknown hook event "${event}"`);
    const raw = (await io.stdin?.()) ?? "";
    let input: HookInput;
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new HookSkip("hook input is not JSON");
    }
    await handler(input, io);
  } catch (e) {
    io.stderr(`homeostat: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return 0;
}
