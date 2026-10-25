import {
  CORE_AREA,
  type ConfigEdit,
  RESERVED_REPO_NAMES,
  remoteRepo,
  setupStep,
  slugify,
} from "@homeostat/core";
import { describeError, parseRepoRef, type SetupContext, type Step } from "../context.ts";

/** Step 3: the code repos, each checked with the token. */
export const reposStep: Step = {
  info: setupStep("repos") as NonNullable<ReturnType<typeof setupStep>>,
  supply: "--repo owner/name (repeatable)",
  async detect(ctx) {
    const local = ctx.local().repos ?? { state: "missing" };
    if (local.state !== "done") return local;
    const api = ctx.reader();
    if (!api) return local;
    for (const repo of ctx.codeRepos()) {
      const ref = parseRepoRef(repo);
      if (!ref) continue;
      try {
        await api.probePullRequests(ref);
      } catch (e) {
        return { state: "broken", reason: `${repo}: ${describeError(e)}` };
      }
    }
    return local;
  },
  async run(ctx) {
    const api = await ctx.ensureReader();
    if (!api) ctx.say("  (not checked against the host: no token in this run)");
    const known = ctx.codeRepos();
    let wanted: string[] = ctx.flags.repo?.length ? ctx.flags.repo : [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!wanted.length) {
        const answer = await ctx.ask(
          "  Code repos the daily run reads (owner/name or URL, comma-separated)",
          known.join(", "),
        );
        wanted = answer.split(/[,\s]+/).filter(Boolean);
      }
      const refs = wanted.map((w) => remoteRepo(w) ?? w);
      const bad = refs.filter((r) => !parseRepoRef(r));
      const failed: string[] = [];
      if (!bad.length && api) {
        for (const r of refs) {
          try {
            await api.probePullRequests(
              parseRepoRef(r) as NonNullable<ReturnType<typeof parseRepoRef>>,
            );
            ctx.say(`  ${ctx.paint("green", "✓")} ${r}: its pull requests are readable`);
          } catch (e) {
            ctx.say(`  ${ctx.paint("red", "✗")} ${r}: ${describeError(e)}`);
            failed.push(r);
          }
        }
      }
      if (bad.length) ctx.say(`  not owner/name: ${bad.join(", ")}`);
      if (!bad.length && !failed.length && refs.length) {
        save(ctx, refs);
        return;
      }
      wanted = [];
      if (!ctx.interactive) return;
    }
  },
};

/**
 * One repo, or a KB that already has rules or top-level areas, keeps `sources.repos`; several
 * repos in a new KB get the multi-repo layout, so each repo's rules stay apart.
 */
function save(ctx: SetupContext, refs: string[]) {
  const config = ctx.config();
  if (!config) return;
  const files = Object.keys(ctx.files()).filter(
    (p) => p.startsWith("knowledge/") && !p.startsWith(`knowledge/${CORE_AREA}/`),
  );
  const multi =
    config.repos !== undefined ||
    (refs.length > 1 && Object.keys(config.areas).length === 0 && files.length === 0);
  const edits: ConfigEdit[] = [];
  if (multi) {
    const taken = new Set(Object.keys(config.repos ?? {}));
    const known = new Set(Object.values(config.repos ?? {}).map((r) => r.source));
    for (const ref of refs) {
      if (known.has(ref)) continue;
      let short = slugify(ref.split("/")[1]) ?? "repo";
      if ((RESERVED_REPO_NAMES as readonly string[]).includes(short)) short = `${short}-repo`;
      while (taken.has(short)) short = `${short}-2`;
      taken.add(short);
      edits.push({ path: ["repos", short], set: { source: ref } });
    }
    if (config.sources?.repos.length) edits.push({ path: ["sources", "repos"], delete: true });
  } else {
    edits.push({
      path: ["sources", "repos"],
      set: [...new Set([...(config.sources?.repos ?? []), ...refs])],
    });
    if (refs.length > 1 && files.length)
      ctx.say(
        "  The KB already has rules, so the repos share one layout; homeostat migrate splits it by repo later.",
      );
  }
  if (edits.length) ctx.edit(edits);
}
