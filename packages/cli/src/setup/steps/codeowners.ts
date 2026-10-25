import { setupStep } from "@homeostat/core";
import { runCodeowners } from "../../codeowners.ts";
import { hostChecks } from "../../doctor.ts";
import { PROTECTION_HELP } from "../../init.ts";
import { TOKEN_VARS } from "../../provider.ts";
import { EMAIL_VAR, type Step } from "../context.ts";

/** Step 9 (optional, recommended): CODEOWNERS written, and branch protection read back or explained. */
export const codeownersStep: Step = {
  info: setupStep("codeowners") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    const local = ctx.local().codeowners ?? { state: "optional" };
    if (local.state !== "done") return local;
    const quiet = { ...ctx.io, stdout: () => {}, stderr: () => {} };
    return runCodeowners(ctx.root, { check: true }, quiet) === 0
      ? local
      : { state: "broken", reason: "CODEOWNERS is out of date" };
  },
  async run(ctx) {
    const config = ctx.config();
    const host = ctx.host();
    if (!config || !host) return;
    if (runCodeowners(ctx.root, {}, ctx.io) !== 0) return;
    // Protection, read back where the token may (the same checks as doctor --security).
    const auth = ctx.admin ?? ctx.envAuth(host);
    if (auth) {
      const env = {
        ...ctx.io.env,
        [TOKEN_VARS[host][0]]: auth.token,
        ...(auth.user ? { [EMAIL_VAR]: auth.user } : {}),
      };
      const { access } = await hostChecks(config, { ...ctx.io, env });
      for (const c of access)
        ctx.say(
          `  ${c.level === "ok" ? ctx.paint("green", "✓") : c.level === "fail" ? ctx.paint("red", "✗") : "·"} ${c.message}`,
        );
      if (access.every((c) => c.level === "ok")) return;
    }
    ctx.say(PROTECTION_HELP[host].replace(/^/gm, "  "));
  },
};
