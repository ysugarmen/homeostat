import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  AGENT_ENV,
  addCredits,
  broadScopesFor,
  CONFIG_FILE,
  CORE_AREA,
  type Config,
  countTokens,
  detectRepo,
  docContext,
  docRef,
  type Entry,
  fillBudget,
  inRepo,
  isMultiRepo,
  isRejectedDecision,
  logEvent,
  logTurnUsage,
  memberFromGit,
  PROMPT_GUIDE,
  pruneEvents,
  rankForFile,
  readKbFiles,
  readKbView,
  readLinesFrom,
  renderContext,
  renderTitles,
  repoNames,
  restCounts,
  rulesForCode,
  searchEntries,
  searchSections,
  selectEntries,
  selectForFile,
  sessionGuide,
  summarizeTurns,
  tokenize,
  UNKNOWN_KEY,
  VERSION,
  validate,
  visibleTo,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { git, gitIdentity } from "./git.ts";
import { memberIdFrom } from "./init.ts";
import { loadKbInForce } from "./kb-cache.ts";
import { installedPlugin, recordPlugin, selfUpdateDue } from "./plugin-info.ts";
import { pendingFingerprint, readSyncState, syncDue, takeNotices } from "./sync.ts";
import { touchedPaths, uncommitted } from "./touched.ts";

/** Claude Code's limit on SessionStart `additionalContext`. */
const MAX_CONTEXT_CHARS = 10_000;
/** Room kept for document sections when the KB has any, and for the lookup guide with its counts. */
const DOC_RESERVE = 2_500;
const GUIDE_RESERVE = 1_500;
/** Tokens kept for the guide's lines counting the rules and documents not given in full. */
const COUNT_TOKENS = 40;

export interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  transcript_path?: string;
  trigger?: string;
  /** Stop: the current turn's final reply, which the transcript file may not hold yet. */
  last_assistant_message?: string;
  /** UserPromptSubmit: the message the developer sent. */
  prompt?: string;
  /** PostToolUse: the tool the agent used, and its input (a file path for Read, Edit, Write). */
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    notebook_path?: string;
    /** Edit: the new text; Write: the whole file; MultiEdit: each edit's new text. */
    new_string?: string;
    content?: string;
    edits?: { new_string?: string }[];
    /** Bash: the command about to run. */
    command?: string;
  };
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

/**
 * The room a session start gives rules: the token budget less the lookup guide (in full when it
 * leaves the rules at least half, else compact), at most four fifths of it, and the characters
 * left after the guide's and the documents' reserves. `homeostat eval` scores with the same.
 */
export function sessionRuleBudget(
  config: Pick<Config, "distribution">,
  hasDocs: boolean,
): { tokenBudget: number; maxChars: number; compactGuide: boolean } {
  // Rules first, but never all of the room: the document sections and the guide keep theirs.
  const docRoom = hasDocs ? DOC_RESERVE : 0;
  // Its count lines are not known yet; COUNT_TOKENS covers them.
  const budget = config.distribution.tokenBudget;
  const guideCost = (compact: boolean) =>
    countTokens(sessionGuide({ rules: new Map(), docs: new Map(), compact })) + COUNT_TOKENS;
  const compactGuide = budget - guideCost(false) < budget / 2;
  return {
    // At most four fifths, as before the guide existed, so large budgets keep their rules.
    tokenBudget: Math.max(0, Math.min(Math.floor(budget * 0.8), budget - guideCost(compactGuide))),
    maxChars: MAX_CONTEXT_CHARS - GUIDE_RESERVE - docRoom,
    compactGuide,
  };
}

async function sessionStart(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot) return;
  // The injection event is written last, so it carries the hook's wall time (as the CLI saw it,
  // without the launcher's spawn or Node's startup) and whether the start got through.
  const started = performance.now();
  const ts = (io.now?.() ?? new Date()).toISOString();
  const record: Record<string, unknown> = {};
  let failed = false;
  try {
    await selectForSession(input, io, cwd, kbRoot, (fields) => Object.assign(record, fields));
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    logEvent(kbRoot, {
      ts,
      type: "injection",
      session: input.session_id,
      source: input.source,
      cwd,
      ...record,
      ok: !failed,
      ms: Math.round(performance.now() - started),
    });
  }
}

async function selectForSession(
  input: HookInput,
  io: Io,
  cwd: string,
  kbRoot: string,
  note: (fields: Record<string, unknown>) => void,
) {
  const { config, entries, docs, issues } = loadKbInForce(kbRoot);
  if (!config) throw new HookSkip("knowledge base config is invalid; run homeostat validate");
  pruneEvents(kbRoot, config.security.eventRetentionDays, io.now?.() ?? new Date());

  const paths = touchedPaths(cwd);
  const member = memberFromGit(config.team.members, gitIdentity(cwd));
  // A multi-repo KB: shared rules plus this checkout's repo; none of the other repos'.
  const repo = repoHere(cwd, config);
  const visibleDocs = visibleTo(
    inRepo(docs, config, repo).map((d) => ({ ...d, frontmatter: d.doc.frontmatter })),
    config,
    member,
  );
  const { tokenBudget, maxChars, compactGuide } = sessionRuleBudget(config, visibleDocs.length > 0);
  const selection = selectEntries(
    visibleTo(
      inRepo(entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
      config,
      member,
    ),
    { paths, tokenBudget, maxChars, broad: broadScopesFor(config, repo) },
  );
  note({
    ...(repo ? { repo } : {}),
    paths: paths.length,
    entries: selection.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
    dropped: selection.dropped,
    tokens: selection.tokens,
  });

  const rules = renderContext(selection);
  // What was not given in full is counted, not listed, with how and when to look it up.
  const documents = docContext(visibleDocs, paths, {
    tokenBudget: config.distribution.docTokenBudget,
    maxChars: MAX_CONTEXT_CHARS - rules.length - GUIDE_RESERVE - 4,
  });
  const guide = sessionGuide({
    rules: restCounts(selection.rest),
    docs: documents.byArea,
    compact: compactGuide,
  });
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
  // Which plugin Claude Code runs here, for the heartbeat: a hook an older plugin does not
  // register never runs, whatever version of this CLI it launches.
  recordPlugin(kbRoot, io.env ?? {});
  // An older plugin updates itself, in the background, when its marketplace may auto-update
  // (an admin's or the developer's setting): Claude Code skips that where its own updates are
  // off, and a hook an older plugin does not register never runs.
  const plugin = installedPlugin(io.env ?? {});
  if (plugin && selfUpdateDue(kbRoot, plugin, VERSION, io.env ?? {}, io.now?.() ?? new Date()))
    io.background?.(["plugin-update", "--dir", kbRoot]);
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
  // The team's config has options this version does not know: it reads the rest, and says so.
  const unknown = issues.filter((i) => i.code === UNKNOWN_KEY).map((i) => i.path ?? "");
  const outdated = unknown.length
    ? `# Homeostat is out of date\n\nThe team's homeostat.yaml uses ${unknown.length === 1 ? "an option" : "options"} this Homeostat (${VERSION}) does not know (${unknown.join(", ")}), so ${unknown.length === 1 ? "it is" : "they are"} ignored. Tell the user once, in one line: run \`claude plugin update homeostat@homeostat\` and restart Claude Code, or, if the plugin is current, the KB's CI pins an older Homeostat than its config needs.`
    : "";
  const join = (docs: string) =>
    [rules, docs, guide, header, unplaced, outdated].filter(Boolean).join("\n\n");
  // The guide is sized by its counts; on the rare KB where it outgrows its reserve, the document
  // sections give way rather than Claude Code cutting the end of the context.
  const context =
    join(documents.text).length <= MAX_CONTEXT_CHARS ? join(documents.text) : join("");
  note({ chars: context.length });
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
  /** Repo-relative files whose rules this session was given when it opened them. */
  files?: string[];
  /** Rules given because code the agent wrote contained one of their triggers; once each. */
  triggered?: string[];
  /** Rules this session was shown by title only, so a title is listed once. */
  titled?: string[];
  /** When the last shell command ended: files changed after it were edited by the next one. */
  bashAt?: string;
  /** Diffs (by hash) the commit check already showed rules for; the next try goes through. */
  commitChecked?: string[];
  /** Document sections (`<doc>#<id>`) given for a message, so each is given once. */
  sections?: string[];
  /** The KB view the session last saw (HEAD + pending set); unchanged means nothing to add. */
  view?: string;
  /** Files already changed when the session started, so the Stop hook counts only its own. */
  dirtyAtStart?: string[];
  /** Where the last logged turn starts in the transcript, and its number, for `turn-usage`. */
  usage?: { offset: number; turn: number };
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

/**
 * One `turn-usage` event per user turn: the Homeostat tools called, whether they retrieved, and
 * the ids credited. Reads the transcript from the turn it logged last, so each Stop re-checks the
 * previous turn (the Stop hook can fire before a reply is flushed to the file, which undercounted
 * credits 2.4x in vectorize-io/hindsight's measurements) and logs the new ones; the event store
 * keeps one event per turn. Ids are kept only when they name a rule or section in the KB.
 */
function logTurns(input: HookInput, io: Io, kbRoot: string) {
  const session = input.session_id;
  if (!session || !input.transcript_path || io.env?.HOMEOSTAT_NO_TURN_USAGE) return;
  const state = readState(kbRoot, session);
  const cursor = state.usage ?? { offset: 0, turn: 0 };
  const { lines, from } = readLinesFrom(input.transcript_path, cursor.offset);
  const restart = from !== cursor.offset;
  const turns = summarizeTurns(lines, restart || cursor.turn === 0 ? 1 : cursor.turn);
  const last = turns.at(-1);
  if (!last) return;
  // The reply Claude Code hands the hook directly is the current turn's, even if the file lags.
  if (typeof input.last_assistant_message === "string") {
    addCredits(last, input.last_assistant_message);
  }
  const known = turns.some((t) => t.credits.length) ? creditable(kbRoot) : new Set<string>();
  const now = (io.now?.() ?? new Date()).toISOString();
  for (const t of turns) {
    const credits = t.credits.filter((id) => known.has(id));
    const other = t.otherCredits + t.credits.length - credits.length;
    logTurnUsage(kbRoot, {
      ts: t.at ?? now,
      session,
      turn: t.turn,
      calls: t.calls,
      retrieved: t.retrieved,
      credited: t.creditLines > 0,
      credits,
      ...(other ? { otherCredits: other } : {}),
    });
  }
  writeState(kbRoot, session, {
    ...readState(kbRoot, session),
    usage: { offset: last.offset, turn: last.turn },
  });
}

/** Every id a credit can name: rule ids, `area/topic` documents and `area/topic#section`. */
function creditable(kbRoot: string): Set<string> {
  const { entries, docs } = loadKbInForce(kbRoot);
  const ids = new Set<string>();
  for (const e of entries) ids.add(e.entry.frontmatter.id.toLowerCase());
  for (const d of docs) {
    const ref = docRef(d.path).toLowerCase();
    ids.add(ref);
    for (const s of d.doc.sections) if (s.id) ids.add(`${ref}#${s.id.toLowerCase()}`);
  }
  return ids;
}

async function stop(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot || !input.session_id) return;
  // Lessons written during this reply go up now, not at the next session.
  if (pendingFingerprint(kbRoot) !== readSyncState(kbRoot).pushed) {
    io.background?.(["sync", "--dir", kbRoot, "--quiet", "--push-only"]);
  }
  try {
    logTurns(input, io, kbRoot);
  } catch {
    // Usage counts are a by-product: they never stop a session or the handoff below.
  }
  const { config } = validate(readKbFiles(kbRoot), { checks: false });
  if (!config?.agents.handoff.enabled) return;

  const state = readState(kbRoot, input.session_id);
  if (state.asked) return;
  // Edit tool calls, or files changed since the session started, whichever is more: agents also
  // edit through the shell (sed, scripts), which no tool call shows.
  const before = new Set(state.dirtyAtStart ?? []);
  const changed = state.dirtyAtStart ? uncommitted(cwd).filter((p) => !before.has(p)).length : 0;
  const edits = Math.max(countEdits(input.transcript_path), changed);
  if (edits < config.agents.handoff.minEdits && !state.compacted) return;

  const member = memberFromGit(config.team.members, gitIdentity(cwd));
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
 * plus any decisions on the developer's own lessons. Every message also gets a one-line reminder of
 * when to look things up and how to credit it: repeating it each turn is what keeps agents
 * searching (see guide.ts). It is a fixed string, so the common path reads no KB files.
 */
async function prompt(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot || !input.session_id) return;
  if (syncDue(kbRoot, io.now?.() ?? new Date(), SYNC_EVERY_HOURS)) {
    io.background?.(["sync", "--dir", kbRoot, "--quiet"]);
  }
  let updates = "";
  let matches = "";
  try {
    updates = promptUpdates(input.session_id, io, cwd, kbRoot);
    matches = promptMatches(input.session_id, input.prompt ?? "", io, cwd, kbRoot);
  } finally {
    // The reminder goes out even when looking for updates failed.
    io.stdout(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: [updates, matches, PROMPT_GUIDE].filter(Boolean).join("\n\n"),
        },
      })}\n`,
    );
  }
}

/** The rules and notices this session has not seen yet, as text; "" when nothing changed. */
function promptUpdates(session: string, io: Io, cwd: string, kbRoot: string): string {
  const state = readState(kbRoot, session);
  const view = viewKey(kbRoot);
  const news = takeNotices(kbRoot);
  if (view === state.view && news.length === 0) return "";

  const { config, entries } = loadKbInForce(kbRoot);
  if (!config) return "";
  const member = memberFromGit(config.team.members, gitIdentity(cwd));
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
      broad: broadScopesFor(config, repo),
    },
  );
  const fresh = selection.items.filter((i) => !seen.has(i.entry.frontmatter.id));
  writeState(kbRoot, session, {
    ...state,
    injected: [...seen, ...fresh.map((i) => i.entry.frontmatter.id)],
    view,
  });
  if (fresh.length === 0 && news.length === 0) return "";
  if (fresh.length) {
    logEvent(kbRoot, {
      ts: (io.now?.() ?? new Date()).toISOString(),
      type: "injection",
      session,
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
  return parts.join("\n\n");
}

/** A message needs this many words before it is matched against the KB. */
const PROMPT_MIN_TERMS = 3;
/** Words of conversation, not of the work: "yes, go ahead", "run the tests again", "commit it". */
const CHAT = new Set(
  "ahead again also all can check commit continue could done fine go good great just keep let look make me more my next nice no not now ok okay perfect please proceed push run see show so some start stop sure test thank that then there thi try wait will would ye yes".split(
    " ",
  ),
);

/** At most this many rules and document sections are given per message. */
const PROMPT_RULES = 3;
const PROMPT_SECTIONS = 2;
/**
 * A hit is given when it shares this many rare words with the message, and scores at least this
 * share of the best hit of its kind. BM25 scores depend on the KB's size, so they make no floor; a
 * word is rare when at most this share of the rules (or sections) hold it, so "yes, go ahead" or
 * "run the tests again" match nothing. Set on 32 prompts drawn from a real team's reviews: the rule
 * each came from was the best hit for 27 and among the first two for most of the rest.
 */
const PROMPT_MIN_SHARED = 2;
const PROMPT_CLOSE = 0.6;
const PROMPT_RARE = 0.1;

/** Whether `fields` share `PROMPT_MIN_SHARED` of the message's words that are rare in `pool`. */
function sharesRare(words: Set<string>, pool: readonly string[][]) {
  const df = new Map<string, number>();
  for (const doc of pool)
    for (const w of new Set(doc)) if (words.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const most = Math.max(2, PROMPT_RARE * pool.length);
  return (...fields: string[]) =>
    new Set(tokenize(fields.join(" ")).filter((w) => words.has(w) && (df.get(w) ?? 0) <= most))
      .size >= PROMPT_MIN_SHARED;
}
/** A section longer than this is cut, with a pointer to read the rest. */
const PROMPT_SECTION_CHARS = 2400;

/**
 * The rules and document sections whose words match the developer's message, given once per
 * session. The session start chooses by the files being changed; a question or a bug report names
 * no file yet, so its own words choose here. Keyword search on the CPU: no model call.
 */
function promptMatches(session: string, text: string, io: Io, cwd: string, kbRoot: string): string {
  const words = new Set(tokenize(text).filter((w) => !CHAT.has(w)));
  if (words.size < PROMPT_MIN_TERMS) return "";
  const { config, entries, docs } = loadKbInForce(kbRoot);
  if (!config) return "";
  const member = memberFromGit(config.team.members, gitIdentity(cwd));
  const repo = repoHere(cwd, config);
  const state = readState(kbRoot, session);
  const seen = new Set(state.injected ?? []);
  const seenSections = new Set(state.sections ?? []);
  const close = <T extends { score: number }>(hits: T[]) =>
    hits.filter((h) => h.score >= PROMPT_CLOSE * (hits[0]?.score ?? 0));

  const pool = visibleTo(
    inRepo(entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
    config,
    member,
  ).filter((e) => !isRejectedDecision(e.frontmatter));
  const ruleText = (e: Pick<(typeof pool)[number], "frontmatter" | "sections">) => [
    e.frontmatter.title,
    (e.frontmatter.tags ?? []).join(" "),
    e.sections.rule ?? "",
  ];
  const ruleShares = sharesRare(
    words,
    pool.map((e) => tokenize(ruleText(e).join(" "))),
  );
  const rules = close(searchEntries(pool, text, { limit: PROMPT_RULES })).filter(
    ({ entry: e }) => !seen.has(e.frontmatter.id) && ruleShares(...ruleText(e)),
  );
  const sectionPool = visibleTo(
    inRepo(docs, config, repo).map((d) => ({ ...d, frontmatter: d.doc.frontmatter })),
    config,
    member,
  ).flatMap(({ path, doc }) =>
    doc.sections.map((s) => ({
      doc: docRef(path),
      title: doc.frontmatter.title,
      id: s.id,
      heading: s.heading,
      body: s.body,
    })),
  );
  const sectionShares = sharesRare(
    words,
    sectionPool.map((s) => tokenize(`${s.heading} ${s.body}`)),
  );
  const sections = close(searchSections(sectionPool, text, { limit: PROMPT_SECTIONS })).filter(
    ({ section: s }) => !seenSections.has(`${s.doc}#${s.id}`) && sectionShares(s.heading, s.body),
  );
  if (rules.length === 0 && sections.length === 0) return "";

  const ids = rules.map((h) => h.entry.frontmatter.id);
  const refs = sections.map((h) => ({ doc: h.section.doc, id: h.section.id }));
  writeState(kbRoot, session, {
    ...state,
    injected: [...seen, ...ids],
    sections: [...seenSections, ...refs.map((r) => `${r.doc}#${r.id}`)],
  });
  const ts = (io.now?.() ?? new Date()).toISOString();
  if (ids.length)
    logEvent(kbRoot, {
      ts,
      type: "injection",
      session,
      source: "prompt",
      cwd,
      ...(repo ? { repo } : {}),
      entries: ids.map((id) => ({ id, form: "full" })),
    });
  if (refs.length)
    logEvent(kbRoot, {
      ts,
      type: "doc-injection",
      session,
      source: "prompt",
      docs: [...new Set(refs.map((r) => r.doc))],
      sections: refs,
    });

  const parts = [
    "# Matching this message (homeostat)",
    "Team rules and document sections whose words match the message. Use what applies; ignore the rest.",
    ...(rules.length
      ? [
          renderContext({
            items: rules.map((h) => ({ entry: h.entry, form: "full" as const })),
          }).replace(/^# Team knowledge \(homeostat\)\n\n[\s\S]*?\n\n(?=## |\*\*)/, ""),
        ]
      : []),
    ...sections.map(({ section: s }) => {
      const body =
        s.body.length > PROMPT_SECTION_CHARS
          ? `${s.body.slice(0, PROMPT_SECTION_CHARS).replace(/\s+\S*$/, "")} [...] (read the rest with \`read\` ${s.doc}#${s.id})`
          : s.body;
      return `## ${s.heading} (${s.doc}#${s.id})\n${body}`;
    }),
  ];
  return parts.join("\n\n");
}

/** Tokens of rules a file brings when a session opens it: a few rules, not a context dump. */
const FILE_TOKENS = 700;
/** At most this many more of a file's own rules are listed by title when it is opened. */
const FILE_TITLES = 20;
/** At most this many more rules for a commit are listed by title. */
const COMMIT_TITLES = 50;
/** Of those, at least this many are the changed files' own rules (learned on or near them). */
const COMMIT_NEARBY = 15;
/** Tokens of rules the code just written brings in full: one or two, right after the edit. */
const CODE_TOKENS = 300;
/** At most this many more rules the code just written triggers are listed by title. */
const CODE_TITLES = 15;
/** Tokens of the rules a commit check shows in full: the code's best few. */
const COMMIT_TOKENS = 900;

/** The text an Edit, Write or MultiEdit just wrote; "" for a Read. */
function writtenCode(input: HookInput): string {
  const t = input.tool_input ?? {};
  return [t.new_string, t.content, ...(t.edits ?? []).map((e) => e.new_string)]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
}

/** Rendered rules without the session header, for a hook's own heading. */
const ruleBlocks = (selection: Parameters<typeof renderContext>[0]) =>
  renderContext(selection).replace(
    /^# Team knowledge \(homeostat\)\n\n[\s\S]*?\n\n(?=## |\*\*)/,
    "",
  );

/** The repo a path is in and the path relative to it; undefined outside a repo or in the KB. */
function inCodeRepo(kbRoot: string, cwd: string, file: string) {
  // Real paths on both sides: git answers with them, and a symlinked folder (macOS's /var is
  // /private/var) would otherwise put the file outside its own repo.
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const abs = real(resolve(cwd, file));
  const top = git(dirname(abs), "rev-parse", "--show-toplevel");
  if (!top) return undefined;
  const root = real(top);
  if (root === real(kbRoot)) return undefined;
  const rel = relative(root, abs).replaceAll("\\", "/");
  if (!rel || rel.startsWith("..")) return undefined;
  return { root, rel };
}

/** At most this many files a single shell command opens get their rules: the rest come later. */
const OPEN_PER_COMMAND = 3;
/** A file a shell command changed is read whole for triggers only below this size. */
const MAX_NEW_FILE = 100_000;
const CODE_EXT =
  /\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|rs|sql|ya?ml|toml|json|sh|tf|md|proto|tpl|html|css|scss)$/;

/** A file the agent touched: where it is, and the code just written to it ("" for a read). */
interface Touch {
  root: string;
  rel: string;
  code: string;
}

/**
 * The files a shell command touched: every path it names that is a file, resolved from the
 * session's folder or a `cd`/`-C` folder in the command. One that changed since the last command
 * was edited (by sed, a heredoc, a script): its code is what the change added. Agents in auto
 * mode read and edit with shell commands as often as with Read and Edit.
 */
export function bashTouches(
  kbRoot: string,
  cwd: string,
  command: string,
  since: number,
  env: Io["env"],
) {
  const home = env?.HOME;
  // A command runs where it cds to (or where git -C points): those folders come before the
  // session's own, where the same relative path may name the main checkout instead.
  const bases: string[] = [];
  // Quoted folders may hold spaces ("~/Work Repos/app").
  for (const m of command.matchAll(/(?:\bcd|\s-C)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'&;|]+))/g)) {
    const dir = m[1] ?? m[2] ?? m[3] ?? "";
    bases.push(resolve(cwd, dir.startsWith("~/") && home ? join(home, dir.slice(2)) : dir));
  }
  bases.push(cwd);
  const seen = new Set<string>();
  const out: Touch[] = [];
  // Quoted strings whole first (a path may hold spaces), then the words of the command.
  const quoted = [...command.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)].map((m) => m[1] ?? m[2] ?? "");
  for (const raw of [...quoted, ...command.split(/[\s"'`=(),;|&<>]+/)]) {
    let token = raw.replace(/:\d+(?::\d+)?$/, "").replace(/[.:,]+$/, "");
    if (!token || token.startsWith("-") || token.includes("://")) continue;
    if (!token.includes("/") && !CODE_EXT.test(token)) continue;
    if (token.startsWith("~/") && home) token = join(home, token.slice(2));
    for (const base of bases) {
      const abs = resolve(base, token);
      if (seen.has(abs)) break;
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) break;
      seen.add(abs);
      const at = inCodeRepo(kbRoot, cwd, abs);
      if (!at) break;
      let code = "";
      if (st.mtimeMs > since) {
        const diff = git(at.root, "diff", "--unified=0", "--no-color", "HEAD", "--", at.rel) ?? "";
        code = diff
          .split("\n")
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
          .map((l) => l.slice(1))
          .join("\n");
        // Not in git yet: the whole new file is what was written.
        if (!diff && st.size < MAX_NEW_FILE) {
          try {
            code = readFileSync(abs, "utf8");
          } catch {
            code = "";
          }
        }
      }
      out.push({ ...at, code });
      break;
    }
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * PostToolUse on Read, Edit, Write and Bash. The first time a session opens a file: the rules
 * about it (learned on it or near it, naming it, or scoped to it), before the agent plans anything
 * around it. Agents read code first and look rules up later, if ever; this way the rules a
 * reviewer wrote about a file arrive with the file. Then, on every edit: the rules whose
 * triggers the new code contains, once each, so a practice rule (a type, a call, a library)
 * arrives the moment the agent writes such code, in whatever file. A shell command counts too:
 * a file it changed (sed, a heredoc, a script) is opened and edited; one it only names is not.
 */
async function fileUse(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  if (!input.session_id) return;
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot) return;
  const state = readState(kbRoot, input.session_id);
  const now = io.now?.() ?? new Date();
  let touches: Touch[];
  if (input.tool_name === "Bash") {
    const command = input.tool_input?.command;
    if (!command) return;
    // Changed since the previous shell command (or the last minute): edited by this one.
    const since = state.bashAt ? Date.parse(state.bashAt) : now.getTime() - 60_000;
    touches = bashTouches(kbRoot, cwd, command, since, io.env);
  } else {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const at = file ? inCodeRepo(kbRoot, cwd, file) : undefined;
    touches = at ? [{ ...at, code: writtenCode(input) }] : [];
  }
  const opened = new Set(state.files ?? []);
  // From a shell command, only the files it changed: one it merely names (a grep, a diff, a cat
  // of many files) is not one the agent is working on, and its rules would crowd the session.
  const toOpen = touches
    .filter((t) => !opened.has(t.rel) && (input.tool_name !== "Bash" || t.code))
    // Edited files first: the ones the agent is working on.
    .sort((a, b) => Number(!!b.code) - Number(!!a.code))
    .slice(0, OPEN_PER_COMMAND);
  const written = touches.filter((t) => t.code);
  if (!toOpen.length && !written.length) {
    if (input.tool_name === "Bash")
      writeState(kbRoot, input.session_id, { ...state, bashAt: now.toISOString() });
    return;
  }

  const { config, entries } = loadKbInForce(kbRoot);
  if (!config) return;
  const contexts = new Map<
    string,
    { repo: string | undefined; pool: Entry[]; broad: ReturnType<typeof broadScopesFor> }
  >();
  const contextFor = (root: string) => {
    let c = contexts.get(root);
    if (!c) {
      const member = memberFromGit(config.team.members, gitIdentity(root));
      const repo = repoHere(root, config);
      const pool = visibleTo(
        inRepo(entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
        config,
        member,
      );
      c = { repo, pool, broad: broadScopesFor(config, repo) };
      contexts.set(root, c);
    }
    return c;
  };
  const seen = new Set(state.injected ?? []);
  // A title is listed once a session: the files an agent works through share many rules.
  const titled = new Set(state.titled ?? []);
  const ts = now.toISOString();
  const parts: string[] = [];
  const fileIds: string[] = [];
  let repoSeen: string | undefined;
  for (const t of toOpen) {
    const { repo, pool, broad } = contextFor(t.root);
    repoSeen ??= repo;
    const ranked = rankForFile(
      pool.filter((e) => !seen.has(e.frontmatter.id)),
      t.rel,
      { broad, ...(t.code ? { code: t.code } : {}) },
    );
    const forFile = fillBudget(
      ranked.map((r) => r.entry),
      { tokenBudget: FILE_TOKENS },
    );
    const ids = forFile.items.map((i) => i.entry.frontmatter.id);
    for (const id of ids) seen.add(id);
    fileIds.push(...ids);
    // The file's other rules learned on it or near it, or about it, by title: a hot file holds
    // dozens, and the agent picks the ones its change touches better than any ranking.
    const alsoHere = ranked
      .filter(
        (r) =>
          r.tier <= 3 &&
          !ids.includes(r.entry.frontmatter.id) &&
          !titled.has(r.entry.frontmatter.id),
      )
      .slice(0, FILE_TITLES)
      .map((r) => r.entry);
    for (const e of alsoHere) titled.add(e.frontmatter.id);
    if (!ids.length) continue;
    logEvent(kbRoot, {
      ts,
      type: "injection",
      session: input.session_id,
      source: "file",
      cwd,
      ...(repo ? { repo } : {}),
      entries: forFile.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
    });
    parts.push(
      `# Team rules about ${t.rel} (homeostat)\n\nReviewers wrote these about this file or the code near it. Follow them in what you plan or change here.\n\n${ruleBlocks(forFile)}${
        alsoHere.length
          ? `\n\nAlso learned on or near this file; read any that your change touches (explain <id>):\n${renderTitles(alsoHere)}`
          : ""
      }`,
    );
  }
  // A triggered rule comes again even if the session start gave it: the code just written is
  // the moment it matters. Once per session, and never twice in one answer.
  const triggered = new Set([...(state.triggered ?? []), ...fileIds]);
  const fired: Entry[] = [];
  const firedIds = new Set<string>();
  for (const t of written) {
    for (const e of rulesForCode(contextFor(t.root).pool, t.rel, t.code)) {
      if (triggered.has(e.frontmatter.id) || firedIds.has(e.frontmatter.id)) continue;
      firedIds.add(e.frontmatter.id);
      fired.push(e);
    }
  }
  // In a team trial one edit fired a median of 5 rules and up to 80; the best go in full, and
  // the agent picks from the others' titles better than any ranking of them.
  const forCode = fillBudget(fired.slice(0, 2), { tokenBudget: CODE_TOKENS });
  const codeFull = new Set(forCode.items.map((i) => i.entry.frontmatter.id));
  const codeTitles = fired
    .filter(
      (e) =>
        !codeFull.has(e.frontmatter.id) &&
        !titled.has(e.frontmatter.id) &&
        !seen.has(e.frontmatter.id),
    )
    .slice(0, CODE_TITLES);
  for (const e of codeTitles) titled.add(e.frontmatter.id);
  const codeIds = [...codeFull, ...codeTitles.map((e) => e.frontmatter.id)];
  if (codeIds.length) {
    const repo = written[0] ? contextFor(written[0].root).repo : repoSeen;
    logEvent(kbRoot, {
      ts,
      type: "injection",
      session: input.session_id,
      source: "code",
      cwd,
      ...(repo ? { repo } : {}),
      entries: [
        ...forCode.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
        ...codeTitles.map((e) => ({ id: e.frontmatter.id, form: "title" })),
      ],
    });
    const where = [...new Set(written.map((t) => t.rel))].slice(0, 3).join(", ");
    parts.push(
      [
        `# Team rules about the code you just wrote (homeostat)\n\nWhat you just wrote in ${where} is the kind of code these rules are about. Check it against them now, and fix it if it breaks one.`,
        forCode.items.length ? ruleBlocks(forCode) : "",
        codeTitles.length
          ? `The code also matches these; read any that fit what you wrote (explain <id>):\n${renderTitles(codeTitles)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  writeState(kbRoot, input.session_id, {
    ...state,
    files: [...opened, ...toOpen.map((t) => t.rel)],
    injected: [...new Set([...seen, ...codeIds])],
    triggered: [...(state.triggered ?? []), ...codeIds],
    titled: [...titled],
    ...(input.tool_name === "Bash" ? { bashAt: ts } : {}),
  });
  if (!parts.length) return;
  io.stdout(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: parts.join("\n\n") },
    })}\n`,
  );
}

/** `git commit` in a shell command, not inside a quoted message or another word. */
const GIT_COMMIT = /(?:^|[;&|(]\s*|\s)git(?:\s+-[Cc]\s+\S+)*\s+commit\b/;
/** `-a`, `--all` or a short-flag group holding `a` (`-am`): the commit takes tracked changes. */
const COMMIT_ALL = /\s(?:--all|-[A-Za-z]*a[A-Za-z]*)(?=\s|$)/;

/** Added lines per file, from a `git diff --unified=0`. */
function addedLines(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.startsWith("+++ b/") ? line.slice(6) : undefined;
      if (file && !out.has(file)) out.set(file, "");
    } else if (file && line.startsWith("+")) {
      out.set(file, `${out.get(file)}${line.slice(1)}\n`);
    }
  }
  return out;
}

/**
 * PreToolUse on Bash: before the agent's `git commit` goes through, the rules for what it is
 * committing (those learned on or near the changed files, naming them, scoped to them, or
 * triggered by the added lines) are shown, and the commit is held once so the agent checks the
 * diff against them. The same diff then commits without a second stop.
 */
async function commitCheck(input: HookInput, io: Io) {
  const command = input.tool_input?.command;
  if (!command || !GIT_COMMIT.test(command) || !input.session_id) return;
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot) return;
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (!top || resolve(top) === resolve(kbRoot)) return;
  const { config, entries } = loadKbInForce(kbRoot);
  if (!config || !config.distribution.commitCheck) return;
  const diff =
    git(top, "diff", COMMIT_ALL.test(command) ? "HEAD" : "--cached", "--unified=0", "--no-color") ??
    "";
  if (!diff.trim()) return;
  const hash = createHash("sha256").update(diff).digest("hex").slice(0, 16);
  const state = readState(kbRoot, input.session_id);
  if (state.commitChecked?.includes(hash)) return;

  const member = memberFromGit(config.team.members, gitIdentity(top));
  const repo = repoHere(top, config);
  const pool = visibleTo(
    inRepo(entries, config, repo).map((e) => ({ ...e.entry, path: e.path })),
    config,
    member,
  );
  const broad = broadScopesFor(config, repo);
  const triggered = new Map<string, Entry>();
  const files = [...addedLines(diff)].slice(0, 30);
  // Code first: a trigger in the added lines is the surest sign a rule applies. Each file's
  // best first, file by file in turn, so one busy file does not fill the list.
  const perFile = files.map(([path, added]) => rulesForCode(pool, path, added));
  for (let i = 0; perFile.some((r) => i < r.length); i++) {
    for (const r of perFile) {
      const e = r[i];
      if (e) triggered.set(e.frontmatter.id, e);
    }
  }
  // Then each file's own rules (learned on it or its folder, naming it, or narrowly scoped),
  // nearest first, ranked by the lines added to it; listed by title for the agent to pick from.
  const nearby = new Map<string, Entry>();
  for (const tier of [0, 1, 2]) {
    for (const [path, added] of files) {
      for (const r of rankForFile(pool, path, { broad, code: added })) {
        if (r.tier === tier && !triggered.has(r.entry.frontmatter.id)) {
          nearby.set(r.entry.frontmatter.id, r.entry);
        }
      }
    }
  }
  const selection = fillBudget([...triggered.values()].slice(0, 3), { tokenBudget: COMMIT_TOKENS });
  const shown = new Set(selection.items.map((i) => i.entry.frontmatter.id));
  const rest = (xs: Iterable<Entry>, n: number) =>
    [...xs].filter((e) => !shown.has(e.frontmatter.id)).slice(0, n);
  // The code's matches, then the changed files' own rules: both kept, neither crowding out the other.
  const codeTitles = rest(triggered.values(), COMMIT_TITLES - COMMIT_NEARBY);
  const titles = [...codeTitles, ...rest(nearby.values(), COMMIT_TITLES - codeTitles.length)];
  writeState(kbRoot, input.session_id, {
    ...state,
    commitChecked: [...(state.commitChecked ?? []), hash].slice(-20),
  });
  if (!selection.items.length && !titles.length) return;
  logEvent(kbRoot, {
    ts: (io.now?.() ?? new Date()).toISOString(),
    type: "injection",
    session: input.session_id,
    source: "commit",
    cwd,
    ...(repo ? { repo } : {}),
    entries: [
      ...selection.items.map((i) => ({ id: i.entry.frontmatter.id, form: i.form })),
      ...titles.map((e) => ({ id: e.frontmatter.id, form: "title" })),
    ],
  });
  const reason = [
    "Homeostat: before this commit, check the changes against the team's rules for them (reviewers keep flagging these). Fix anything that breaks one, then run the same commit again: it will go through.",
    selection.items.length
      ? `The code you are committing matches these rules:\n\n${ruleBlocks(selection)}`
      : "",
    titles.length
      ? `Also for these changes (their code matches, or the rule was learned on or near the files); read any your change touches (explain <id>):\n${renderTitles(titles)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  io.stdout(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
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
  file: fileUse,
  commit: commitCheck,
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
