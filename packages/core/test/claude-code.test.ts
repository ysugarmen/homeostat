import { describe, expect, test } from "vitest";
import { z } from "zod";
import { apiAsker, ClaudeUnavailableError } from "../src/claude.ts";
import { AGENT_ENV, type CommandRunner, claudeCodeAsker } from "../src/claude-code.ts";

const schema = z.object({ city: z.string() });

function runner(result: object | string, code = 0) {
  const calls: {
    command: string;
    args: readonly string[];
    input: string;
    env: NodeJS.ProcessEnv;
  }[] = [];
  const run: CommandRunner = async (command, args, input, env) => {
    calls.push({ command, args, input, env });
    return {
      code,
      stdout: typeof result === "string" ? result : JSON.stringify(result),
      stderr: "",
    };
  };
  return { run, calls };
}

const ok = {
  is_error: false,
  subtype: "success",
  stop_reason: "tool_use",
  structured_output: { city: "Paris" },
};

describe("claudeCodeAsker", () => {
  test("runs a bare claude -p with our system prompt, schema, model and effort", async () => {
    const { run, calls } = runner(ok);
    const ask = claudeCodeAsker({
      model: "claude-opus-5-5",
      effort: "medium",
      run,
      env: { PATH: "/bin" },
    });
    expect(await ask("SYSTEM", "Which city?", schema)).toEqual({ city: "Paris" });

    const [call] = calls;
    expect(call?.command).toBe("claude");
    expect(call?.input).toBe("Which city?");
    const args = call?.args ?? [];
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe("-p");
    expect(after("--system-prompt")).toBe("SYSTEM");
    expect(after("--output-format")).toBe("json");
    expect(JSON.parse(after("--json-schema") ?? "{}")).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
    });
    expect(after("--json-schema")).not.toContain("$schema");
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(args).toEqual(
      expect.arrayContaining([
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
      ]),
    );
    expect(after("--model")).toBe("claude-opus-5-5");
    expect(after("--effort")).toBe("medium");
    expect(call?.env).toMatchObject({ PATH: "/bin", [AGENT_ENV]: "1" });
  });

  test("output that does not fit the schema is null", async () => {
    const { run } = runner({ ...ok, structured_output: { town: "Paris" } });
    expect(await claudeCodeAsker({ model: "m", effort: "low", run })("s", "u", schema)).toBeNull();
  });

  test("a refusal is null", async () => {
    const { run } = runner({ ...ok, stop_reason: "refusal", structured_output: undefined });
    expect(await claudeCodeAsker({ model: "m", effort: "low", run })("s", "u", schema)).toBeNull();
  });

  test("a login problem says how to log in", async () => {
    const { run } = runner(
      { is_error: true, subtype: "success", result: "Not logged in · Please run /login" },
      1,
    );
    const err = await claudeCodeAsker({ model: "m", effort: "low", run })("s", "u", schema).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ClaudeUnavailableError);
    expect(err.message).toContain("Not logged in");
    expect(err.message).toContain("claude setup-token");
  });

  test("Claude Code not installed says so", async () => {
    const run: CommandRunner = async () => {
      throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    };
    const err = await claudeCodeAsker({ model: "m", effort: "low", run })("s", "u", schema).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ClaudeUnavailableError);
    expect(err.message).toBe(
      "Claude Code (claude) is not installed: install it, or use agents.runtime: api",
    );
  });

  test("unreadable output is reported with the tail of stderr", async () => {
    const run: CommandRunner = async () => ({ code: 2, stdout: "", stderr: "boom\nreal reason" });
    const err = await claudeCodeAsker({ model: "m", effort: "low", run })("s", "u", schema).catch(
      (e) => e,
    );
    expect(err.message).toBe("Claude Code failed (exit 2): boom real reason");
  });
});

describe("apiAsker credentials", () => {
  test("with an explicit env it ignores keys in the process environment", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-process-env";
    try {
      const ask = apiAsker({ model: "claude-opus-5-5", effort: "low", env: {} });
      const err = await ask("s", "u", schema).catch((e) => e);
      expect(err).toBeInstanceOf(ClaudeUnavailableError);
      expect(err.message).toContain("no usable Claude API credentials");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
