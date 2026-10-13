import { type LearnInput, type McpDeps, serveStdio } from "@homeostat/mcp";
import type { Io } from "./cli.ts";
import { logEvent, readEvents } from "./events.ts";
import { readKbFiles } from "./files.ts";
import { runFlag } from "./flag.ts";
import { git } from "./git.ts";
import { findKb } from "./hook.ts";
import { memberIdFrom } from "./init.ts";
import { runLearn } from "./learn.ts";

/** Runs a CLI command with output captured, for returning to an agent as one message. */
async function captured(run: (io: Io) => number | Promise<number>, base: Io): Promise<string> {
  let out = "";
  let err = "";
  const code = await run({
    ...base,
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    color: false,
  });
  if (code !== 0) throw new Error((err || out).trim() || `exit ${code}`);
  return out.trim();
}

/**
 * The MCP server's host side: reads the KB on every call, and writes learn and flag as commits on
 * the caller's `candidates/<member>` branch (pushed when the KB has an origin), the same path the
 * handoff notes take, so nothing touches the checkout and a reviewer accepts them by PR.
 */
export function mcpDeps(io: Io, cwd = process.cwd()): McpDeps {
  const kbRoot = findKb(io.env, cwd);
  const member = () => memberIdFrom(git(cwd, "config", "user.name"));
  const branchOpts = () => ({
    branch: `candidates/${member()}`,
    push: kbRoot !== undefined && git(kbRoot, "remote", "get-url", "origin") !== undefined,
  });
  const quiet: Io = { ...io, ask: undefined } as Io;

  return {
    readKb: () => (kbRoot ? readKbFiles(kbRoot) : {}),
    learn: (input: LearnInput) => {
      if (!kbRoot) return Promise.reject(new Error("no knowledge base configured"));
      return captured(
        (cio) =>
          runLearn(
            undefined,
            {
              dir: kbRoot,
              title: input.title,
              rule: input.rule,
              why: input.why,
              ...(input.area ? { area: input.area } : {}),
              ...(input.scope?.length ? { scope: input.scope } : {}),
              author: member(),
              ...branchOpts(),
            },
            cio,
          ),
        quiet,
      );
    },
    flag: (id, reason) => {
      if (!kbRoot) return Promise.reject(new Error("no knowledge base configured"));
      return captured(
        (cio) => runFlag(id, { dir: kbRoot, reason, by: member(), ...branchOpts() }, cio),
        quiet,
      );
    },
    log: (event) => {
      if (kbRoot) logEvent(kbRoot, event);
    },
    events: () =>
      kbRoot
        ? readEvents(kbRoot, { since: new Date(Date.now() - 366 * 86_400_000).toISOString() })
        : [],
    now: () => io.now?.() ?? new Date(),
  };
}

/** `homeostat mcp`: the MCP server on stdio, as started by the plugin's .mcp.json or any client. */
export async function runMcp(io: Io): Promise<number> {
  await serveStdio(mcpDeps(io));
  return 0;
}
