import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  type Asker,
  ClaudeUnavailableError,
  type Effort,
  takesEffort,
  type Usage,
} from "./claude.ts";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command with `input` on stdin; rejects with an ENOENT error when it is not installed. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
) => Promise<RunResult>;

const spawnRunner: CommandRunner = (command, args, input, env) =>
  new Promise((resolve, reject) => {
    // Run outside any repo so no project CLAUDE.md or settings are picked up.
    const child = spawn(command, [...args], {
      cwd: tmpdir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

export interface ClaudeCodeAskerOptions {
  model: string;
  effort: Effort;
  /** The Claude Code binary; defaults to `claude` on the PATH. */
  command?: string;
  /** Injected for tests. */
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /** Called after each call with what it used, and Claude Code's own cost estimate. */
  onUsage?: (usage: Usage) => void;
}

/** Set on the child so the homeostat plugin's own hooks never fire inside an agent call. */
export const AGENT_ENV = "HOMEOSTAT_AGENT";

/**
 * Flags for a bare structured call: our system prompt instead of Claude Code's, no tools, no MCP
 * servers, no skills, no user/project settings (so no plugins or hooks). That keeps a call at
 * about a thousand input tokens instead of the full interactive context.
 */
export function claudeCodeArgs(
  opts: { model: string; effort: Effort },
  system: string,
  jsonSchema: object,
) {
  return [
    "-p",
    "--system-prompt",
    system,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(jsonSchema),
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--model",
    opts.model,
    ...(takesEffort(opts.model) ? ["--effort", opts.effort] : []),
  ];
}

const resultSchema = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

/**
 * The Claude Code runtime: runs `claude -p`, which uses whatever Claude Code is logged in with:
 * an interactive login, a `claude setup-token` token as CLAUDE_CODE_OAUTH_TOKEN, or an API key.
 * Anthropic's terms limit a personal Free/Pro/Max subscription to the subscriber's own,
 * non-commercial use and forbid sharing its token, so a team KB should use the API runtime or a
 * Team/Enterprise plan instead (see docs/execution-plan.md, decisions log).
 */
export function claudeCodeAsker(opts: ClaudeCodeAskerOptions): Asker {
  const run = opts.run ?? spawnRunner;
  const command = opts.command ?? "claude";
  return async (system, user, schema) => {
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    const args = claudeCodeArgs(opts, system, jsonSchema);
    let out: RunResult;
    try {
      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), [AGENT_ENV]: "1" };
      // A model without effort thinks on a budget Claude Code sets high: off, unless set explicitly.
      if (!takesEffort(opts.model) && env.MAX_THINKING_TOKENS === undefined)
        env.MAX_THINKING_TOKENS = "0";
      out = await run(command, args, user, env);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClaudeUnavailableError(
          `Claude Code (${command}) is not installed: install it, or use agents.runtime: api`,
        );
      }
      throw e;
    }

    let parsed: z.infer<typeof resultSchema>;
    try {
      parsed = resultSchema.parse(JSON.parse(out.stdout));
    } catch {
      const detail = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
      throw new ClaudeUnavailableError(`Claude Code failed (exit ${out.code}): ${detail}`);
    }
    if (parsed.usage || parsed.total_cost_usd !== undefined)
      opts.onUsage?.({
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        ...(parsed.total_cost_usd !== undefined ? { costUsd: parsed.total_cost_usd } : {}),
      });
    if (parsed.is_error || parsed.subtype !== "success") {
      const detail = parsed.result ?? parsed.subtype ?? "unknown error";
      const login = /log ?in|auth|credential|token|api key/i.test(detail)
        ? " (run `claude` to log in, or set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`)"
        : "";
      throw new ClaudeUnavailableError(`Claude Code: ${detail}${login}`);
    }
    if (parsed.stop_reason === "refusal") return null;
    const value = schema.safeParse(parsed.structured_output);
    return value.success ? value.data : null;
  };
}
