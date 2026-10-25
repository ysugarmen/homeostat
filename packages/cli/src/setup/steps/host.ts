import { remoteRepo, setupStep } from "@homeostat/core";
import { git } from "../../git.ts";
import { detectHost, guide, HOSTS, runInit } from "../../init.ts";
import { HOST_NAME, type Host, parseRepoRef, type SetupContext, type Step } from "../context.ts";

/** An https remote on bitbucket.org, which takes an API token, not the account password. */
export const httpsBitbucket = (remote: string | undefined) =>
  Boolean(remote && /^https:\/\/([^@/]+@)?bitbucket\.org\//i.test(remote.trim()));

export const HTTPS_BITBUCKET_HINT = `Over HTTPS, Bitbucket takes an API token as the password, with the username x-bitbucket-api-token-auth. More: ${guide("clone-over-https")}`;

/** Step 1: homeostat.yaml (from `init` when there is none), the host and the KB repo. */
export const hostStep: Step = {
  info: setupStep("host") as NonNullable<ReturnType<typeof setupStep>>,
  supply: "--host github|bitbucket; the KB repo comes from the origin remote",
  async detect(ctx) {
    return ctx.local().host ?? { state: "missing" };
  },
  async run(ctx) {
    const remote = git(ctx.root, "remote", "get-url", "origin");
    let host =
      (ctx.flags.host as Host | undefined) ??
      ctx.host() ??
      (remote ? detectHost(remote) : undefined);
    if (!host || !HOSTS.includes(host)) {
      host = await ctx.choose<Host>("Where is the KB repo hosted?", [
        { value: "github", label: "GitHub" },
        { value: "bitbucket", label: "Bitbucket" },
      ]);
      if (!host) return;
    }
    if (host === "bitbucket" && httpsBitbucket(remote)) ctx.say(`  ${HTTPS_BITBUCKET_HINT}`);

    if (ctx.configText() === undefined) {
      const code = runInit(ctx.root, { host, guide: false }, ctx.io);
      if (code !== 0) return;
    } else if (!ctx.config()) {
      ctx.say(
        "  homeostat.yaml is invalid: run homeostat validate to see every issue, fix it, and rerun setup.",
      );
      return;
    }

    let kb = ctx.config()?.sources?.kbRepo ?? (remote ? remoteRepo(remote) : undefined);
    if (!kb) {
      kb = await askRepo(ctx, `  KB repo on ${HOST_NAME[host]} (example: acme/team-kb)`);
      if (!kb) return;
    }
    const base = git(ctx.root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")?.replace(
      /^origin\//,
      "",
    );
    ctx.edit([
      { path: ["sources", "host"], set: host },
      { path: ["sources", "kbRepo"], set: kb },
      ...(base && base !== "main" ? [{ path: ["sources", "baseBranch"], set: base }] : []),
    ]);
  },
};

async function askRepo(ctx: SetupContext, question: string): Promise<string | undefined> {
  for (let i = 0; i < 3 && ctx.interactive; i++) {
    const answer = await ctx.ask(question);
    const ref = remoteRepo(answer) ?? answer;
    if (parseRepoRef(ref)) return ref;
    ctx.say("  Write it as owner/name (example: acme/team-kb), or paste the repo's URL.");
  }
  return undefined;
}
