import { remoteRepo, setupStep } from "@homeostat/core";
import { git } from "../../git.ts";
import { detectHost, HOSTS, runInit } from "../../init.ts";
import { type Host, parseRepoRef, type SetupContext, type Step } from "../context.ts";

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
    while (!host || !HOSTS.includes(host)) {
      const answer = await ctx.ask("  Git host of the KB repo: github or bitbucket");
      if (!ctx.interactive) return;
      host = answer.toLowerCase() as Host;
    }

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
      kb = await askRepo(ctx, `  The KB repo on ${host} (owner/name)`);
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
    ctx.say("  write it as owner/name, or paste the repo's URL");
  }
  return undefined;
}
