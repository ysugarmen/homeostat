import { setupStep } from "@homeostat/core";
import type { HostAuth } from "../../cli.ts";
import {
  describeError,
  EMAIL_VAR,
  errorStatus,
  parseRepoRef,
  type SetupContext,
  type Step,
  TOKEN_VAR,
} from "../context.ts";

const HELP = {
  bitbucket: `  The daily run needs one token that reaches the KB repo and every code repo:
    - an Atlassian API token of a bot account in the workspace, plus that account's email (any
      plan; scopes read:repository:bitbucket, write:repository:bitbucket,
      read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:workspace:bitbucket), or
    - a workspace access token (Bitbucket Premium; scopes repository:write, pullrequest:write).
  A repository access token reaches one repo only, so it is not enough. Code repos need read
  access only. Storing it as a CI variable needs admin on the KB repo (admin:pipeline:bitbucket);
  setup asks whether to use this token or a separate one for that write.`,
  github: `  The daily run reads PRs from the code repos and opens PRs on the KB repo. Create a
  fine-grained token (or a GitHub App) with:
    code repos: Pull requests read, Contents read;  KB repo: Pull requests write, Contents write;
    org: Members read (to ask reviewers).`,
};

/** Step 2: the CI token, verified with real reads and stored where CI reads it. */
export const tokenStep: Step = {
  info: setupStep("token") as NonNullable<ReturnType<typeof setupStep>>,
  supply: `${TOKEN_VAR.bitbucket} (and ${EMAIL_VAR} for an API token) or ${TOKEN_VAR.github} in the environment`,
  async detect(ctx) {
    const host = ctx.host();
    if (!host) return { state: "missing", reason: "needs the host step first" };
    const name = TOKEN_VAR[host];
    const exists = await ctx.secretExists(name);
    if (exists === true) return { state: "done", reason: `${name} is stored` };
    if (exists === false) return { state: "missing", reason: `${name} is not stored` };
    return {
      state: "unknown",
      reason: `cannot tell whether ${name} is stored: ${ctx.ciUnreadable}`,
    };
  },
  async run(ctx) {
    const host = ctx.host();
    const kb = ctx.kbRepo();
    if (!host || !kb) return;
    ctx.say(HELP[host]);
    const token = await ctx.secret(`  ${TOKEN_VAR[host]}`, TOKEN_VAR[host]);
    if (!token) return;
    let auth: HostAuth = { token };
    if (host === "bitbucket") {
      const user =
        ctx.io.env?.[EMAIL_VAR] ??
        (await ctx.ask(
          "  Its account email, for an API token (empty for a workspace access token)",
        ));
      if (user) auth = { token, user };
    }
    const verified = await verify(ctx, auth);
    if (!verified) return;
    ctx.auth = verified;
    const stored = await ctx.storeSecret(TOKEN_VAR[host], verified.token);
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
        ctx.say("  That is an access token (Bearer): no email needed.");
        auth = { token: auth.token };
      } catch {
        ctx.say(`  ${ctx.paint("red", "✗")} ${describeError(e)}`);
        return undefined;
      }
    } else {
      ctx.say(`  ${ctx.paint("red", "✗")} ${describeError(e)}`);
      if (host === "bitbucket" && !auth.user && errorStatus(e) === 401)
        ctx.say("  An Atlassian API token needs its account email: rerun and give it.");
      return undefined;
    }
  }
  const kind =
    host === "github"
      ? "GitHub token"
      : auth.user
        ? "Atlassian API token (with its account email)"
        : "access token";
  ctx.say(
    `  ${ctx.paint("green", "✓")} the ${kind} reads the KB repo, the code repos and the members`,
  );
  return auth;
}
