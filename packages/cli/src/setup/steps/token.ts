import { setupStep } from "@homeostat/core";
import type { HostAuth } from "../../cli.ts";
import { TOKEN_SCOPES } from "../../init.ts";
import { EMAIL_VARS, LEGACY_TOKEN_VAR, TOKEN_VARS } from "../../provider.ts";
import {
  describeError,
  EMAIL_VAR,
  errorStatus,
  HOST_NAME,
  parseRepoRef,
  type SetupContext,
  type Step,
  TOKEN_VAR,
} from "../context.ts";

/** Step 2: the CI token, verified with real reads and stored where CI reads it. */
export const tokenStep: Step = {
  info: setupStep("token") as NonNullable<ReturnType<typeof setupStep>>,
  supply: `${TOKEN_VAR} in the environment (on Bitbucket with ${EMAIL_VAR} for an Atlassian API token)`,
  async detect(ctx) {
    const host = ctx.host();
    if (!host) return { state: "missing", reason: "needs the host step first" };
    return ctx.secretState(TOKEN_VAR, LEGACY_TOKEN_VAR[host]);
  },
  async run(ctx) {
    const host = ctx.host();
    const kb = ctx.kbRepo();
    if (!host || !kb) return;
    ctx.say(TOKEN_SCOPES[host].replace(/^/gm, "  "));
    const token = await ctx.secret(`the ${HOST_NAME[host]} token`, TOKEN_VARS[host]);
    if (!token) return;
    let auth: HostAuth = { token };
    if (host === "bitbucket") {
      const user = EMAIL_VARS.map((v) => ctx.io.env?.[v]).find(Boolean) ?? (await ctx.askEmail());
      if (user) auth = { token, user };
    }
    const verified = await verify(ctx, auth);
    if (!verified) return;
    ctx.auth = verified;
    const stored = await ctx.storeSecret(TOKEN_VAR, verified.token);
    if (host === "bitbucket" && verified.user && stored)
      await ctx.storeSecret(EMAIL_VAR, verified.user, false);
  },
};

/**
 * Reads the KB repo, one code repo's PRs and the members with the token. On Bitbucket a 401 with
 * an email retries without it: a pasted access token tells itself apart that way.
 */
async function verify(ctx: SetupContext, auth: HostAuth): Promise<HostAuth | undefined> {
  const host = ctx.host();
  const kb = ctx.kbRepo();
  if (!host || !kb) return undefined;
  const check = async (a: HostAuth) => {
    const api = ctx.client(host, a);
    await api.getRepository(kb);
    const code = ctx.codeRepos()[0];
    const ref = code ? parseRepoRef(code) : undefined;
    if (ref) await api.probePullRequests(ref);
    await api.listMembers(kb);
  };
  try {
    await check(auth);
  } catch (e) {
    if (host === "bitbucket" && auth.user && errorStatus(e) === 401) {
      try {
        await check({ token: auth.token });
        ctx.say("  That is an access token, so no email is needed.");
        auth = { token: auth.token };
      } catch {
        ctx.bad(describeError(e));
        return undefined;
      }
    } else {
      ctx.bad(describeError(e));
      if (host === "bitbucket" && !auth.user && errorStatus(e) === 401)
        ctx.say(
          "  An Atlassian API token also needs the email of the account that created it: rerun and give it.",
        );
      return undefined;
    }
  }
  const kind =
    host === "github"
      ? "GitHub token"
      : auth.user
        ? "Atlassian API token (with its account email)"
        : "access token";
  ctx.ok(`the ${kind} reads the KB repo, the code repos and the members`);
  return auth;
}
