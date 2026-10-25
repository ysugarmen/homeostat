import { readSetupRecord, setupStep, VERSION } from "@homeostat/core";
import { runBootstrap } from "../../bootstrap.ts";
import { TOKEN_VARS } from "../../provider.ts";
import { EMAIL_VAR, type Step } from "../context.ts";

/** Step 12 (optional): a first base, previewed (nothing sent) before it asks. */
export const bootstrapStep: Step = {
  info: setupStep("bootstrap") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    return ctx.local().bootstrap ?? { state: "optional" };
  },
  async run(ctx) {
    ctx.say(
      "  The preview lists every file it would read from your local checkouts, and the cost:",
    );
    if ((await runBootstrap({ dir: ctx.root, dryRun: true }, ctx.io)) !== 0) {
      ctx.say(
        "  Check the code repos out next to the KB (or pass --checkout to homeostat bootstrap), then rerun this step.",
      );
      return;
    }
    if (!(await ctx.yes("  Send these prompts to the model and open one PR per repo?"))) return;
    // The credentials typed in this run, for this one command; nothing is written down.
    const host = ctx.host();
    const env = { ...ctx.io.env };
    if (ctx.modelKey) env.ANTHROPIC_API_KEY = ctx.modelKey;
    if (host && ctx.auth) {
      env[TOKEN_VARS[host][0]] = ctx.auth.token;
      if (ctx.auth.user) env[EMAIL_VAR] = ctx.auth.user;
    }
    await runBootstrap({ dir: ctx.root, yes: true }, { ...ctx.io, env });
  },
};

/** Step 13 (optional): the line each teammate runs, once. */
export const teammatesStep: Step = {
  info: setupStep("teammates") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    return ctx.shared || readSetupRecord(ctx.root).teammates?.state === "done"
      ? { state: "done", reason: "join command shared" }
      : { state: "optional" };
  },
  async run(ctx) {
    ctx.say(`  Each teammate clones the KB and runs, once, in it:

    npx --yes homeostat@${VERSION} setup --join

  It installs the Claude Code plugin, points it at their checkout and checks their git name is a
  member. By hand, that is:

    claude plugin marketplace add ysugarmen/homeostat
    claude plugin install homeostat@homeostat
    (then /plugin > homeostat > Configure: kb_dir = their KB checkout)`);
    ctx.shared = true;
  },
};
