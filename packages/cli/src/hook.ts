import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_ENV,
  CONFIG_FILE,
  CORE_AREA,
  type Config,
  detectRepo,
  docContext,
  inRepo,
  isMultiRepo,
  logEvent,
  pruneEvents,
  readKbFiles,
  readKbView,
  renderContext,
  repoNames,
  selectEntries,
  validate,
  visibleTo,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { git } from "./git.ts";
import { memberIdFrom } from "./init.ts";
import { pendingFingerprint, readSyncState, syncDue, takeNotices } from "./sync.ts";
import { touchedPaths, uncommitted } from "./touched.ts";

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

  const { config, entries, docs } = validate(readKbView(kbRoot, { inForce: true }).files);
  if (!config) throw new HookSkip("knowledge base config is invalid; run homeostat validate");
  pruneEvents(kbRoot, config.security.eventRetentionDays, io.now?.() ?? new Date());

  const paths = touchedPaths(cwd);
  const member = memberIdFrom(git(cwd, "config", "user.name"));
  // A multi-repo KB: shared rules plus this checkout's repo; none of the other repos'.
  const repo = repoHere(cwd, config);
  const selection = selectEntries(
    visibleTo(
      inRepo(entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
      config,
      member,
    ),
    { paths, tokenBudget: config.distribution.tokenBudget, maxChars: MAX_CONTEXT_CHARS },
  );
  logEvent(kbRoot, {
    ts: (io.now?.() ?? new Date()).toISOString(),
    type: "injection",
    session: input.session_id,
    source: input.source,
    cwd,
    ...(repo ? { repo } : {}),
    paths: paths.length,
    entries: selection.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
    dropped: selection.dropped,
    tokens: selection.tokens,
  });

  const rules = renderContext(selection);
  const documents = docContext(
    visibleTo(
      inRepo(docs, config, repo).map((d) => ({ ...d, frontmatter: d.doc.frontmatter })),
      config,
      member,
    ),
    paths,
    {
      tokenBudget: config.distribution.docTokenBudget,
      maxChars: MAX_CONTEXT_CHARS - rules.length - 2,
      readHint:
        'Read a section with the homeostat MCP tool `read` ({"doc": "<area>/<topic>", "section": "<id>"}) before changing code it describes.',
    },
  );
  if (documents.listed.length) {
    logEvent(kbRoot, {
      ts: (io.now?.() ?? new Date()).toISOString(),
      type: "doc-injection",
      session: input.session_id,
      docs: documents.listed,
      sections: documents.sections,
    });
  }
  if (input.session_id) {
    const previous = readState(kbRoot, input.session_id);
    writeState(kbRoot, input.session_id, {
      ...previous,
      injected: selection.items.map((i) => i.entry.frontmatter.id),
      view: viewKey(kbRoot),
      // Kept from the first start: resume, clear and compact start the same session again.
      dirtyAtStart: previous.dirtyAtStart ?? uncommitted(cwd),
    });
  }
  // Catch up with the daily run in the background; this session starts with what is local now.
  if (syncDue(kbRoot, io.now?.() ?? new Date(), 0))
    io.background?.(["sync", "--dir", kbRoot, "--quiet"]);
  const news = takeNotices(kbRoot);
  const header = news.length
    ? `# Homeostat updates\n\n${news.map((n) => `- ${n.text}`).join("\n")}`
    : "";
  const unplaced =
    isMultiRepo(config) && !repo
      ? `# Homeostat\n\nThis checkout is not one of the knowledge base's repos (${repoNames(config).join(", ")}), so only the team's shared rules apply here.`
      : "";
  const context = [rules, documents.text, header, unplaced].filter(Boolean).join("\n\n");
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
  /** Rule ids this session has been given, so a later update adds only what is new. */
  injected?: string[];
  /** The KB view the session last saw (HEAD + pending set); unchanged means nothing to add. */
  view?: string;
  /** Files already changed when the session started, so the Stop hook counts only its own. */
  dirtyAtStart?: string[];
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
  const areas = [CORE_AREA, ...Object.keys(config.areas)].join(", ");
  return `homeostat: before you finish, decide whether this session produced a lesson worth a handoff note for teammates' agents: a decision that was made, and what was tried and rejected. If not, reply only "No handoff note." and stop.

If yes, save exactly one note, without asking the user:

${homeostatCommand()} learn --dir "${kbRoot}" --source agent-handoff --author ${member} --area <area> --title "<imperative title, at most 80 characters>" --rule "<what to do next time, at most 60 words>" --why "<what was tried and rejected, and why, at most 100 words>"

Areas: ${areas}. Then reply with one line saying the note was saved; the daily run decides it for the team.`;
}

async function stop(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot || !input.session_id) return;
  // Lessons written during this reply go up now, not at the next session.
  if (pendingFingerprint(kbRoot) !== readSyncState(kbRoot).pushed) {
    io.background?.(["sync", "--dir", kbRoot, "--quiet", "--push-only"]);
  }
  const { config } = validate(readKbFiles(kbRoot));
  if (!config?.agents.handoff.enabled) return;

  const state = readState(kbRoot, input.session_id);
  if (state.asked) return;
  // Edit tool calls, or files changed since the session started, whichever is more: agents also
  // edit through the shell (sed, scripts), which no tool call shows.
  const before = new Set(state.dirtyAtStart ?? []);
  const changed = state.dirtyAtStart ? uncommitted(cwd).filter((p) => !before.has(p)).length : 0;
  const edits = Math.max(countEdits(input.transcript_path), changed);
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

/** What a session's view of the KB depends on: the checked-out commit and the pending set. */
function viewKey(kbRoot: string): string {
  return `${git(kbRoot, "rev-parse", "HEAD") ?? "none"}:${pendingFingerprint(kbRoot)}`;
}

/**
 * Every message the developer sends (UserPromptSubmit). Sessions can run for days, so this keeps
 * them current: it starts a background sync at most every few hours, and when the KB view has
 * changed since the session last looked, it adds only the rules this session has not seen yet,
 * plus any decisions on the developer's own lessons. Most messages change nothing and print nothing.
 */
async function prompt(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot || !input.session_id) return;
  if (syncDue(kbRoot, io.now?.() ?? new Date(), SYNC_EVERY_HOURS)) {
    io.background?.(["sync", "--dir", kbRoot, "--quiet"]);
  }
  const state = readState(kbRoot, input.session_id);
  const view = viewKey(kbRoot);
  const news = takeNotices(kbRoot);
  if (view === state.view && news.length === 0) return;

  const { config, entries } = validate(readKbView(kbRoot, { inForce: true }).files);
  if (!config) return;
  const member = memberIdFrom(git(cwd, "config", "user.name"));
  const seen = new Set(state.injected ?? []);
  const repo = repoHere(cwd, config);
  const selection = selectEntries(
    visibleTo(
      inRepo(entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
      config,
      member,
    ),
    {
      paths: touchedPaths(cwd),
      tokenBudget: config.distribution.tokenBudget,
      maxChars: MAX_CONTEXT_CHARS,
    },
  );
  const fresh = selection.items.filter((i) => !seen.has(i.entry.frontmatter.id));
  writeState(kbRoot, input.session_id, {
    ...state,
    injected: [...seen, ...fresh.map((i) => i.entry.frontmatter.id)],
    view,
  });
  if (fresh.length === 0 && news.length === 0) return;
  if (fresh.length) {
    logEvent(kbRoot, {
      ts: (io.now?.() ?? new Date()).toISOString(),
      type: "injection",
      session: input.session_id,
      source: "update",
      cwd,
      ...(repo ? { repo } : {}),
      entries: fresh.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
    });
  }
  const parts = [
    "# Team knowledge updated (homeostat)",
    ...(news.length ? [news.map((n) => `- ${n.text}`).join("\n")] : []),
    ...(fresh.length
      ? [
          "New rules for the files in this session, in addition to those you already have:",
          renderContext({ items: fresh }).replace(
            /^# Team knowledge \(homeostat\)\n\n[\s\S]*?\n\n(?=## )/,
            "",
          ),
        ]
      : []),
  ];
  io.stdout(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: parts.join("\n\n"),
      },
    })}\n`,
  );
}

/** How often a long session checks for a new daily run. */
const SYNC_EVERY_HOURS = 3;

async function preCompact(input: HookInput, io: Io) {
  const kbRoot = findKb(io.env, input.cwd ?? process.cwd());
  if (!kbRoot || !input.session_id) return;
  writeState(kbRoot, input.session_id, { ...readState(kbRoot, input.session_id), compacted: true });
}

const HANDLERS: Record<string, (input: HookInput, io: Io) => Promise<void>> = {
  "session-start": sessionStart,
  prompt,
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

/** The KB repo this session's checkout is, in a multi-repo KB. */
const repoHere = (cwd: string, config: Config) => detectRepo(cwd, config);
