import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  areaMap,
  ClaudeSeeder,
  CORE_AREA,
  docFilePath,
  type FilePicker,
  logEvent,
  type RepoRef,
  type RepoSnapshot,
  readKbFiles,
  SEED_PICKERS,
  SEED_SYSTEM,
  SEED_TOPICS,
  type SeedTopic,
  seedDoc,
  seedPrompt,
  snapshotRepo,
  validate,
} from "@homeostat/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";
import { git } from "./git.ts";
import { CliError, providerFor } from "./provider.ts";
import { publish } from "./publish.ts";
import { resolveRepo } from "./repo-option.ts";

export interface SeedOptions {
  dir?: string;
  area: string;
  owner: string;
  topic?: string[];
  dryRun?: boolean;
  force?: boolean;
  /** A multi-repo KB: the repo the documents describe (default: the scanned checkout's). */
  repo?: string;
  shared?: boolean;
}

/**
 * `homeostat seed <repo>`: drafts first documents from a local checkout. Manual only: it sends
 * source code (the file tree and a few key files) to the model, so nothing schedules it.
 */
export async function runSeed(repoDir: string, opts: SeedOptions, io: Io): Promise<number> {
  try {
    return await seed(repoDir, opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function seed(repoDir: string, opts: SeedOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const repo = resolve(repoDir);
  const files = readKbFiles(root);
  const { config } = validate(files);
  if (!config) throw new CliError("homeostat.yaml is missing or invalid; run homeostat validate");
  // A multi-repo KB: the documents belong to the scanned checkout's repo (or --repo, --shared).
  const kbRepo = resolveRepo(config, { ...opts, checkout: repo });
  const areas = areaMap(config, kbRepo);
  if ((opts.area !== CORE_AREA && !areas[opts.area]) || (opts.shared && opts.area !== CORE_AREA)) {
    throw new CliError(
      `unknown area "${opts.area}"${kbRepo ? ` in repo ${kbRepo}` : ""}; use one of: ${opts.shared ? CORE_AREA : [CORE_AREA, ...Object.keys(areas)].join(", ")}`,
    );
  }
  if (!config.team.members.some((m) => m.id === opts.owner)) {
    throw new CliError(`${opts.owner} is not a team member`);
  }
  const topics = (opts.topic?.length ? opts.topic : ["architecture", "conventions"]) as SeedTopic[];
  for (const t of topics) {
    if (!(t in SEED_TOPICS))
      throw new CliError(`unknown topic "${t}"; use ${Object.keys(SEED_TOPICS).join(", ")}`);
  }
  const listed = git(repo, "ls-files");
  if (listed === undefined) throw new CliError(`${repo} is not a git checkout`);

  const name = checkoutName(repo);
  const snapshots = snapshotsFor(repo, name, listed, topics, config.sources?.exclude.paths ?? []);
  for (const snapshot of new Set(snapshots.values())) io.stdout(`${describeSnapshot(snapshot)}\n`);
  const bytes = [...new Set(snapshots.values())]
    .flatMap((s) => s.files)
    .reduce((n, f) => n + f.text.length, 0);

  if (opts.dryRun) {
    io.stdout(`\n--- system prompt ---\n${SEED_SYSTEM}\n`);
    for (const t of topics)
      io.stdout(`\n--- prompt for ${t} ---\n${seedPrompt(snapshotOf(snapshots, t), t)}\n`);
    io.stdout("\ndry run: nothing sent, nothing written\n");
    return 0;
  }

  const seeder = io.seeder ?? new ClaudeSeeder(askerFor(config, "curator", io, root));
  const today = (io.now?.() ?? new Date()).toISOString().slice(0, 10);
  const scope = [...(areas[opts.area] ?? ["**"])];
  logEvent(root, {
    type: "seed-run",
    repo: name,
    topics,
    paths: snapshotOf(snapshots, topics[0] ?? "architecture").paths.length,
    chars: bytes,
  });

  let failed = false;
  for (const topic of topics) {
    const path = docFilePath(config, { repo: kbRepo, area: opts.area, topic });
    if (files[path] !== undefined && !opts.force) {
      io.stdout(`skip ${path}: it already exists (seed writes first versions; --force replaces)\n`);
      continue;
    }
    const snapshot = snapshotOf(snapshots, topic);
    const draft = await seeder.draft(snapshot, topic);
    if (!draft) {
      io.stdout(`skip ${topic}: the model declined\n`);
      continue;
    }
    const text = seedDoc(draft, { area: opts.area, owner: opts.owner, scope, repo: name, today });
    const issues = validate({ ...files, [path]: text }).issues.filter((i) => i.file === path);
    const blocking = issues.filter((i) => i.severity === "error" && !i.code.startsWith("risk."));
    if (blocking.length) {
      io.stdout(`skip ${path}:\n${formatIssues(blocking, io).text}`);
      failed = true;
      continue;
    }
    const risky = issues.filter((i) => i.code.startsWith("risk."));
    if (config.sources && git(root, "remote", "get-url", "origin") !== undefined) {
      const [owner = "", repoName = ""] = config.sources.kbRepo.split("/");
      const kbRepo: RepoRef = { owner, name: repoName };
      await publish({
        root,
        branch: `homeostat/seed-${opts.area}-${topic}-${today}`,
        changes: [{ path, text, message: `homeostat: seed ${path} from ${name}` }],
        provider: providerFor(config.sources.host, io, "open the seed PR"),
        kbRepo,
        base: config.sources.baseBranch,
        title: `homeostat: first ${topic} document for ${opts.area}, from ${name}`,
        body: [
          `Drafted by \`homeostat seed\` from a scan of ${name}: ${snapshot.paths.length} paths and ${snapshot.files.length} files (${snapshot.files.map((f) => f.path).join(", ")}).`,
          "",
          "Every section is marked `source=seed` with the model's confidence. Correct anything wrong before merging: other agents will treat it as fact.",
          ...(risky.length
            ? ["", "**Needs a careful read:**", ...risky.map((i) => `- ${i.message}`)]
            : []),
        ].join("\n"),
        io,
      });
    } else {
      const full = join(root, ...path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
      io.stdout(`wrote ${path}; review it, then commit on a branch and open a PR\n`);
    }
    if (risky.length) io.stdout(`${formatIssues(risky, io).text}`);
  }
  return failed ? 1 : 0;
}

/** The repo name a checkout's origin remote gives, else its folder name. */
export function checkoutName(repo: string): string {
  return basename(git(repo, "remote", "get-url", "origin")?.replace(/\.git$/, "") ?? repo);
}

/** One snapshot per file picker the topics use, so topics sharing a picker share a snapshot. */
export function snapshotsFor(
  repo: string,
  name: string,
  listed: string,
  topics: readonly SeedTopic[],
  exclude: readonly string[],
): Map<SeedTopic, RepoSnapshot> {
  const tracked = listed.split("\n").filter(Boolean);
  const read = (p: string) => {
    try {
      return readFileSync(join(repo, p), "utf8");
    } catch {
      return undefined;
    }
  };
  const byPicker = new Map<FilePicker, RepoSnapshot>();
  const out = new Map<SeedTopic, RepoSnapshot>();
  for (const t of topics) {
    const pick = SEED_PICKERS[t];
    const snap = byPicker.get(pick) ?? snapshotRepo(name, tracked, read, exclude, pick);
    byPicker.set(pick, snap);
    out.set(t, snap);
  }
  return out;
}

export function snapshotOf(
  snapshots: Map<SeedTopic, RepoSnapshot>,
  topic: SeedTopic,
): RepoSnapshot {
  const s = snapshots.get(topic);
  if (!s) throw new Error(`no snapshot for ${topic}`);
  return s;
}

export function describeSnapshot(s: RepoSnapshot): string {
  const bytes = s.files.reduce((n, f) => n + f.text.length, 0);
  const extra = [
    ...(s.redacted ? [`${s.redacted} secret(s) redacted`] : []),
    ...(s.skipped ? [`${s.skipped} file(s) holding secrets left out`] : []),
  ];
  return `snapshot of ${s.name}: ${s.paths.length} paths, ${s.files.length} files (${bytes} characters)${extra.length ? `, ${extra.join(", ")}` : ""}`;
}
