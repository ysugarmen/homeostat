import { type Config, setupStep } from "@homeostat/core";
import { firstLine, type SetupContext, type Step } from "../context.ts";

type Runtime = Config["agents"]["runtime"];
const RUNTIMES: readonly Runtime[] = ["api", "claude-code", "bedrock", "vertex"];

const SECRET: Partial<Record<Runtime, string>> = {
  api: "ANTHROPIC_API_KEY",
  "claude-code": "CLAUDE_CODE_OAUTH_TOKEN",
};

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
    const exists = await ctx.secretExists(name);
    if (exists === true)
      return { state: "done", reason: `${config.agents.runtime}: ${name} is stored` };
    if (exists === false) return { state: "missing", reason: `${name} is not stored` };
    return { state: "unknown", reason: `cannot list the CI secrets from here to find ${name}` };
  },
  async run(ctx) {
    const config = ctx.config();
    if (!config) return;
    let runtime = ctx.flags.runtime as Runtime | undefined;
    while (!runtime || !RUNTIMES.includes(runtime)) {
      ctx.say(
        "  How the agents reach Claude: api (a Claude Console API key; right for a team), claude-code\n  (a Claude Code token; Team or Enterprise plans only for a team KB), bedrock or vertex (your cloud account).",
      );
      runtime = (await ctx.ask("  Runtime", config.agents.runtime)) as Runtime;
      if (!ctx.interactive) return;
    }
    if (runtime !== config.agents.runtime)
      ctx.edit([{ path: ["agents", "runtime"], set: runtime }]);

    if (runtime === "bedrock") {
      const region = await ctx.ask("  AWS region", config.agents.bedrock?.region ?? "us-east-1");
      ctx.edit([{ path: ["agents", "bedrock"], set: { region } }]);
      ctx.say(
        `  The CI identity needs bedrock:InvokeModel on the Claude models in ${region}, and AWS credentials\n  in CI (OIDC, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as secured variables). Setup cannot check them.`,
      );
      return;
    }
    if (runtime === "vertex") {
      const projectId = await ctx.ask("  Google Cloud project id", config.agents.vertex?.projectId);
      const region = await ctx.ask("  Region", config.agents.vertex?.region ?? "global");
      ctx.edit([
        { path: ["agents", "vertex"], set: { ...(projectId ? { projectId } : {}), region } },
      ]);
      ctx.say(
        "  The CI identity needs roles/aiplatform.user on the project, through workload identity or a\n  service-account key in GOOGLE_APPLICATION_CREDENTIALS. Setup cannot check them.",
      );
      return;
    }
    if (runtime === "claude-code") {
      ctx.say(
        "  Run  claude setup-token  in another terminal: it signs in and prints a long-lived token. Paste it here.\n  The CI jobs also need Claude Code installed: uncomment the install line in the CI file.",
      );
      const token = await ctx.secret("  CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN");
      if (!token) return;
      if (!token.startsWith("sk-ant-oat")) {
        ctx.say(
          `  ${ctx.paint("red", "✗")} that is not a token from claude setup-token (sk-ant-oat…)`,
        );
        return;
      }
      await ctx.storeSecret("CLAUDE_CODE_OAUTH_TOKEN", token);
      return;
    }
    const key = await ctx.secret(
      "  Claude Console API key (ANTHROPIC_API_KEY)",
      "ANTHROPIC_API_KEY",
    );
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
      ctx.say(`  ${ctx.paint("green", "✓")} the key works`);
      return true;
    }
    ctx.say(
      `  ${ctx.paint("red", "✗")} Anthropic answered ${res.status}${res.status === 401 ? ": the key is wrong or revoked" : ""}`,
    );
  } catch (e) {
    ctx.say(
      `  ${ctx.paint("red", "✗")} could not reach Anthropic: ${firstLine(String((e as Error).message))}`,
    );
  }
  return false;
}
