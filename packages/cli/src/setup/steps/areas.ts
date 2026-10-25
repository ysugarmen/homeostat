import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ConfigEdit, setupStep, slugify } from "@homeostat/core";
import { describeError, parseRepoRef, type SetupContext, type Step } from "../context.ts";

/** Folders that are rarely an area of their own. */
const NOT_AREAS = new Set([
  "node_modules",
  "docs",
  "doc",
  "test",
  "tests",
  "scripts",
  "dist",
  "build",
  "vendor",
  "bin",
  "tmp",
]);

/** Step 4 (optional): areas, proposed from each repo's top-level folders. */
export const areasStep: Step = {
  info: setupStep("areas") as NonNullable<ReturnType<typeof setupStep>>,
  async detect(ctx) {
    return ctx.local().areas ?? { state: "optional" };
  },
  async run(ctx) {
    const config = ctx.config();
    if (!config) return;
    const api = await ctx.ensureReader();
    // A multi-repo KB has areas per repo; otherwise one set covers every repo.
    const groups: { key: string | undefined; label: string; sources: string[] }[] = config.repos
      ? Object.entries(config.repos).map(([key, r]) => ({ key, label: key, sources: [r.source] }))
      : [{ key: undefined, label: "the code repos", sources: config.sources?.repos ?? [] }];
    const edits: ConfigEdit[] = [];
    for (const g of groups) {
      const folders = new Set<string>();
      for (const source of g.sources)
        for (const f of await foldersOf(ctx, source, api)) folders.add(f);
      const proposed = [...folders].filter((f) => !f.startsWith(".") && !NOT_AREAS.has(f));
      const answer = await ctx.ask(
        `  Areas for ${g.label} (top-level folders, comma-separated; - for none)`,
        proposed.join(", "),
      );
      if (!answer || answer === "-") continue;
      const areas: Record<string, string[]> = {};
      for (const folder of answer.split(/[,\s]+/).filter(Boolean)) {
        const name = slugify(folder);
        if (name && name !== "core") areas[name] = [`${folder.replace(/\/+$/, "")}/**`];
      }
      if (!Object.keys(areas).length) continue;
      edits.push({ path: g.key ? ["repos", g.key, "areas"] : ["areas"], set: areas });
    }
    if (edits.length) ctx.edit(edits);
  },
};

/** A local checkout next to the KB (or inside it) wins; else the host's listing of the default branch. */
async function foldersOf(
  ctx: SetupContext,
  source: string,
  api: Awaited<ReturnType<SetupContext["ensureReader"]>>,
): Promise<string[]> {
  const name = source.split("/")[1] ?? source;
  for (const dir of [join(dirname(ctx.root), name), join(ctx.root, name)]) {
    if (existsSync(join(dir, ".git")))
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
  }
  const ref = parseRepoRef(source);
  if (!api || !ref) return [];
  try {
    const repo = await api.getRepository(ref);
    return await api.topLevelFolders(ref, repo.defaultBranch);
  } catch (e) {
    ctx.say(`  could not list ${source}'s folders: ${describeError(e)}`);
    return [];
  }
}
