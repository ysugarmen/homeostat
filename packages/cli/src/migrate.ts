import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ClaudeTopicProposer,
  CORE_AREA,
  isDocPath,
  isMultiRepo,
  type MigrationPlan,
  migrateKb,
  parseEntry,
  readKbFiles,
  validate,
} from "@homeostat/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";
import { CliError, providerFor } from "./provider.ts";

export interface MigrateOptions {
  dir?: string;
  /** One source repo: its short name (default: the repo's own name). */
  repo?: string;
  /** Several: area=repo, one per area (core included, unless --shared). */
  map?: string[];
  /** Keep the core rules shared by every repo, in knowledge/core/. */
  shared?: boolean;
  /** Also group the rules into topic files, with a topic list proposed by the model. */
  topics?: boolean;
  dryRun?: boolean;
  /** Skip the check that no review PR is open (when no host token is at hand). */
  skipPrCheck?: boolean;
}

/**
 * `homeostat migrate`: turns a one-repo KB into the multi-repo layout, optionally grouping its
 * rules by topic. It writes the working tree only: review the result, commit it on a branch and
 * open a PR, like any change to the KB.
 */
export async function runMigrate(opts: MigrateOptions, io: Io): Promise<number> {
  try {
    return await migrate(opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function migrate(opts: MigrateOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const files = readKbFiles(root);
  const kb = validate(files);
  const config = kb.config;
  if (!config) throw new CliError("homeostat.yaml is missing or invalid; run homeostat validate");
  if (isMultiRepo(config)) throw new CliError("this knowledge base already lists its repos");
  const sources = config.sources?.repos ?? [];
  if (sources.length === 0)
    throw new CliError("sources.repos is empty: there is no repo to migrate to");

  const plan = buildPlan(config.areas, sources, opts);
  io.stdout(
    `repos: ${Object.entries(plan.repos)
      .map(([s, src]) => `${s} (${src})`)
      .join(", ")}\nareas: ${Object.entries(plan.areas)
      .map(([a, r]) => `${a} → ${r ?? "shared"}`)
      .join(", ")}\n`,
  );

  if (!opts.skipPrCheck && config.sources) {
    const [owner = "", name = ""] = config.sources.kbRepo.split("/");
    let openPrs: { sourceBranch: string }[];
    try {
      openPrs = await providerFor(
        config.sources.host,
        io,
        "check that no review PR is open",
      ).listOpenPullRequests({ owner, name });
    } catch (e) {
      throw new CliError(
        `${(e as Error).message}; or pass --skip-pr-check if you know no review PR is open`,
      );
    }
    const waiting = openPrs.filter((p) => p.sourceBranch.startsWith("homeostat/"));
    if (waiting.length) {
      throw new CliError(
        `${waiting.length} homeostat PR(s) are open (${waiting.map((p) => p.sourceBranch).join(", ")}): decide or close them first, since their files would move`,
      );
    }
  }

  if (opts.topics) {
    const proposer =
      io.topicProposer ?? new ClaudeTopicProposer(askerFor(config, "curator", io, root));
    plan.topics = {};
    for (const scope of [...Object.keys(plan.repos), ""]) {
      const rules = kb.entries
        .filter((e) => !isDocPath(e.path) && e.entry.frontmatter.status !== "retired")
        .filter((e) => (plan.areas[e.entry.frontmatter.area] ?? "") === scope)
        .map((e) => ({
          id: e.entry.frontmatter.id,
          title: e.entry.frontmatter.title,
          rule: parseEntry(files[e.path] ?? "").entry?.sections.rule ?? "",
        }));
      if (rules.length === 0) continue;
      const proposal = await proposer.propose(rules);
      plan.topics[scope] = proposal;
      io.stdout(
        `topics for ${scope || "the shared rules"}:\n${Object.entries(proposal.topics)
          .map(([t, d]) => {
            const n = Object.values(proposal.assign).filter((x) => x === t).length;
            return `  ${t} (${n}): ${d}`;
          })
          .join("\n")}\n  general: ${rules.filter((r) => !proposal.assign[r.id]).length}\n`,
      );
    }
  }

  const result = migrateKb(
    files,
    config,
    plan,
    (io.now?.() ?? new Date()).toISOString().slice(0, 10),
  );
  for (const n of result.notes) io.stdout(`note: ${n}\n`);
  if (result.issues.length) {
    io.stdout(
      `${formatIssues(result.issues, io).text}the migrated KB would not validate; nothing written\n`,
    );
    return 1;
  }
  const writes = Object.entries(result.files);
  io.stdout(
    `${result.moved.length} files move, ${writes.filter(([, t]) => t !== null).length} written, ${writes.filter(([p, t]) => t === null && files[p] !== undefined).length} removed\n`,
  );
  if (opts.dryRun) {
    for (const [from, to] of result.moved) io.stdout(`  ${from} → ${to}\n`);
    io.stdout("dry run: nothing written\n");
    return 0;
  }
  for (const [path, text] of writes) {
    const full = join(root, ...path.split("/"));
    if (text === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  io.stdout(
    "migrated the working tree. Next: homeostat codeowners, review git diff, then commit on a branch and open a PR. Developers' pending lessons move on their next sync.\n",
  );
  return 0;
}

/** The repos and the area → repo map, from --repo or --map and the sources. */
function buildPlan(
  areas: Record<string, readonly string[]>,
  sources: readonly string[],
  opts: MigrateOptions,
): MigrationPlan {
  const shortOf = (source: string) => (source.split("/")[1] ?? source).toLowerCase();
  const all = [CORE_AREA, ...Object.keys(areas)];
  if (!opts.map?.length) {
    if (sources.length > 1) {
      throw new CliError(
        `sources.repos lists ${sources.length} repos: map each area to one, e.g. ${all
          .filter((a) => a !== CORE_AREA)
          .map((a) => `--map ${a}=${shortOf(sources[0] ?? "")}`)
          .join(" ")} --shared`,
      );
    }
    const source = sources[0] ?? "";
    const repo = opts.repo ?? shortOf(source);
    return {
      repos: { [repo]: source },
      areas: Object.fromEntries(
        all.map((a) => [a, a === CORE_AREA && opts.shared ? undefined : repo]),
      ),
    };
  }
  const repos = Object.fromEntries(sources.map((s) => [shortOf(s), s]));
  const mapped: Record<string, string | undefined> = {};
  for (const m of opts.map) {
    const [area = "", repo = ""] = m.split("=");
    if (!all.includes(area))
      throw new CliError(`--map ${m}: no area "${area}" (${all.join(", ")})`);
    if (!repos[repo])
      throw new CliError(`--map ${m}: no repo "${repo}" (${Object.keys(repos).join(", ")})`);
    mapped[area] = repo;
  }
  if (opts.shared) mapped[CORE_AREA] = undefined;
  const missing = all.filter((a) => !Object.hasOwn(mapped, a));
  if (missing.length) {
    throw new CliError(
      `map every area to a repo: ${missing.map((a) => (a === CORE_AREA ? "--shared (or --map core=<repo>)" : `--map ${a}=<repo>`)).join(", ")}`,
    );
  }
  return { repos, areas: mapped };
}
