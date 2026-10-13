import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, renderContext, selectEntries, validate } from "@kbx/core";
import type { Io } from "./cli.ts";
import { readKbFiles } from "./files.ts";
import { touchedPaths } from "./touched.ts";

/** Claude Code's limit on SessionStart `additionalContext`. */
const MAX_CONTEXT_CHARS = 10_000;

export const EVENTS_FILE = ".kbx/events.jsonl";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
  transcript_path?: string;
  trigger?: string;
}

/** The KB checkout: the plugin's kb_dir option, then $KBX_DIR, then the session dir itself. */
export function findKb(env: Io["env"], cwd: string): string | undefined {
  const configured = env?.CLAUDE_PLUGIN_OPTION_KB_DIR || env?.KBX_DIR;
  if (configured) return resolve(configured);
  return existsSync(join(cwd, CONFIG_FILE)) ? cwd : undefined;
}

/** Appends one event to the KB's git-ignored log; Phase 4 turns this into the dashboard's store. */
export function logEvent(kbRoot: string, event: Record<string, unknown>) {
  mkdirSync(join(kbRoot, ".kbx"), { recursive: true });
  appendFileSync(join(kbRoot, EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

class HookSkip extends Error {}

async function sessionStart(input: HookInput, io: Io) {
  const cwd = input.cwd ?? process.cwd();
  const kbRoot = findKb(io.env, cwd);
  if (!kbRoot) return;

  const { config, entries } = validate(readKbFiles(kbRoot));
  if (!config) throw new HookSkip("knowledge base config is invalid; run kbx validate");

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

const HANDLERS: Record<string, (input: HookInput, io: Io) => Promise<void>> = {
  "session-start": sessionStart,
};

export const HOOK_EVENTS = Object.keys(HANDLERS);

/**
 * `kbx hook <event>`, called by the plugin's hooks with the event JSON on stdin. A hook must
 * never break a session, so every failure is reported on stderr and the exit code is still 0.
 */
export async function runHook(event: string, io: Io): Promise<number> {
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
    io.stderr(`kbx: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return 0;
}
