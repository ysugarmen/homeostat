import { type Config, setupStep } from "@homeostat/core";
import { guide, useClaudeCodeInCi } from "../../init.ts";
import { type Choice, firstLine, type SetupContext, type Step } from "../context.ts";

type Runtime = Config["agents"]["runtime"];

const RUNTIMES: readonly Choice<Runtime>[] = [
  { value: "api", label: "Claude Console API key (recommended for a team)" },
  { value: "claude-code", label: "Claude Code login (a token from claude setup-token)" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Google Vertex" },
];

const SECRET: Partial<Record<Runtime, string>> = {
  api: "ANTHROPIC_API_KEY",
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
};

/** How long the one `claude -p` call that tries a Claude Code token may take. */
const CLAUDE_TIMEOUT_MS = 90_000;

/** Step 7: how the agents reach Claude, with the credential checked and stored. */
export const modelStep: Step = {
  info: setupStep("model") as NonNullable<ReturnType<typeof setupStep>>,
  supply:
    "--runtime api|claude-code|bedrock|vertex; ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment",
  async detect(ctx) {
    const config = ctx.config();
    if (!config) return { state: "missing", reason: "needs the host step first" };
    const local = ctx.local().model;
    if (local) return local;
    const name = SECRET[config.agents.runtime] as string;
    const c = await ctx.secretState(name);
    return c.state === "done" ? { ...c, reason: `${config.agents.runtime}: ${c.reason}` } : c;
  },
  async run(ctx) {
    const config = ctx.config();
    if (!config) return;
    let runtime = ctx.flags.runtime as Runtime | undefined;
    if (!runtime || !RUNTIMES.some((r) => r.value === runtime)) {
      runtime = await ctx.choose(
        "How should the agents reach Claude?",
        RUNTIMES,
        config.agents.runtime,
      );
      if (!runtime) return;
    }
    if (runtime !== config.agents.runtime)
      ctx.edit([{ path: ["agents", "runtime"], set: runtime }]);

    if (runtime === "bedrock") {
      const region = await ctx.ask(
        "  AWS region (example: us-east-1)",
        config.agents.bedrock?.region ?? "us-east-1",
      );
      ctx.edit([{ path: ["agents", "bedrock"], set: { region } }]);
      ctx.say(
        `  The CI identity needs bedrock:InvokeModel on the Claude models in ${region}; setup cannot check it. More: ${guide("model-credential")}`,
      );
      return;
    }
    if (runtime === "vertex") {
      const projectId = await ctx.ask(
        "  Google Cloud project id (example: acme-ai)",
        config.agents.vertex?.projectId,
      );
      const region = await ctx.ask(
        "  Vertex region (example: us-east5)",
        config.agents.vertex?.region ?? "global",
      );
      ctx.edit([
        { path: ["agents", "vertex"], set: { ...(projectId ? { projectId } : {}), region } },
      ]);
      ctx.say(
        `  The CI identity needs roles/aiplatform.user on the project; setup cannot check it. More: ${guide("model-credential")}`,
      );
      return;
    }
    if (runtime === "claude-code") {
      ctx.say("  In another terminal run  claude setup-token , then paste what it prints here.");
      const token = await ctx.secret("the token", "CLAUDE_CODE_OAUTH_TOKEN");
      if (!token || !(await checkClaudeToken(ctx, token))) return;
      await ctx.storeSecret("CLAUDE_CODE_OAUTH_TOKEN", token);
      installClaudeInCi(ctx);
      return;
    }
    ctx.say("  Create a key at console.anthropic.com > Settings > API keys.");
    const key = await ctx.secret("the API key", "ANTHROPIC_API_KEY");
    if (!key || !(await checkApiKey(ctx, key))) return;
    ctx.modelKey = key;
    await ctx.storeSecret("ANTHROPIC_API_KEY", key);
  },
};

/** Lists one model: free, and it fails exactly when the key is wrong or revoked. */
async function checkApiKey(ctx: SetupContext, key: string): Promise<boolean> {
  try {
    const res = await (ctx.io.fetch ?? fetch)("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (res.ok) {
      ctx.ok("the key works");
      return true;
    }
    ctx.bad(
      `Anthropic answered ${res.status}${res.status === 401 ? ": the key is wrong or revoked" : ""}`,
    );
  } catch (e) {
    ctx.bad(`could not reach Anthropic: ${firstLine(String((e as Error).message))}`);
  }
  return false;
}

/** What `claude setup-token` prints: sk-ant-oat, then a long random tail. */
const looksLikeClaudeToken = (t: string) => /^sk-ant-oat\d*-[\w-]{20,}$/.test(t);

/**
 * Tries the token with one tiny `claude -p` call (cheapest model, one turn, no tools, no
 * settings), the token in the child's environment only. Without Claude Code installed, checks
 * its shape instead, and says so.
 */
async function checkClaudeToken(ctx: SetupContext, token: string): Promise<boolean> {
  if (!looksLikeClaudeToken(token)) {
    ctx.bad("that is not a token from claude setup-token (it starts with sk-ant-oat)");
    return false;
  }
  const r = await ctx.run(
    "claude",
    [
      "-p",
      "Reply OK",
      "--max-turns",
      "1",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--no-session-persistence",
    ],
    undefined,
    {
      // Only this token: an API key or another login in the environment would win over it.
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
      },
      timeoutMs: CLAUDE_TIMEOUT_MS,
    },
  );
  if (r.code === 127) {
    ctx.ok(
      "the token has the right shape (Claude Code is not installed here, so it was not tried)",
    );
    return true;
  }
  if (r.code === 124) {
    ctx.ok("the token has the right shape (claude did not answer in time, so it was not tried)");
    return true;
  }
  let failed = r.code !== 0;
  let detail = firstLine(r.stderr);
  try {
    const out = JSON.parse(r.stdout) as { is_error?: boolean; result?: string };
    if (out.is_error) {
      failed = true;
      detail = firstLine(out.result ?? "") || detail;
    }
  } catch {
    // Not JSON: the exit code decides.
  }
  if (failed) {
    ctx.bad(`Claude Code refused the token${detail ? `: ${ctx.redact(detail)}` : ""}`);
    return false;
  }
  ctx.ok("the token works (one short call to Claude Code)");
  return true;
}

/** The CI jobs install Claude Code: the lines `init` wrote commented out are turned on. */
function installClaudeInCi(ctx: SetupContext) {
  const host = ctx.host();
  if (!host) return;
  const { edited, manual } = useClaudeCodeInCi(ctx.root, host);
  for (const path of edited) ctx.ok(`${path} now installs Claude Code (committed in step 10)`);
  for (const m of manual) ctx.say(`  Add this line to the agents' steps in ${m.path}: ${m.line}`);
}
