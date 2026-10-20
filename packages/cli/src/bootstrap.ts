import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  BOOTSTRAP_PARTS,
  type BootstrapPart,
  ClaudeSeeder,
  CORE_AREA,
  type Config,
  convertDoc,
  docFilePath,
  docTopic,
  estimate,
  existingDocs,
  logEvent,
  PART_TOPICS,
  type RepoRef,
  type RepoSnapshot,
  readKbFiles,
  redactSecrets,
  remoteRepo,
  repoNames,
  SEED_SYSTEM,
  type SeedTopic,
  seedDoc,
  seedPrompt,
  validate,
} from "@homeostat/core";
import { askerFor } from "./agents.ts";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";
import { git } from "./git.ts";
import { CliError, providerFor } from "./provider.ts";
import { type FileChange, publish } from "./publish.ts";
import { describeSnapshot, snapshotOf, snapshotsFor } from "./seed.ts";

export interface BootstrapOptions {
  dir?: string;
  /** Only these repos (default: every repo in `repos`). */
  repo?: string[];
  /** `<repo>=<path>` for a checkout that is not found next to the KB or the current folder. */
  checkout?: string[];
  parts?: string[];
  /** Who owns the documents (default: the first reviewer, else the first lead). */
  owner?: string;
  dryRun?: boolean;
  /** Print the full prompts in a dry run. */
  prompts?: boolean;
  yes?: boolean;
  force?: boolean;
}

interface Plan {
  /** The KB repo name; undefined in a KB without repo folders. */
  repo: string | undefined;
  label: string;
  checkout: string;
  name: string;
  docs: { from: string; path: string }[];
  topics: { topic: SeedTopic; path: string; snapshot: RepoSnapshot }[];
  skipped: string[];
}

/**
 * `homeostat bootstrap`: a first base for each repo from its local checkout: the existing docs
 * converted as they are, and documents on the code, data and infrastructure drafted by the
 * model. Manual only: it sends code to the model, so it previews what it reads, asks first, and
 * nothing schedules it. One PR per repo.
 */
export async function runBootstrap(opts: BootstrapOptions, io: Io): Promise<number> {
  try {
    return await bootstrap(opts, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function bootstrap(opts: BootstrapOptions, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const files = readKbFiles(root);
  const { config } = validate(files);
  if (!config) throw new CliError("homeostat.yaml is missing or invalid; run homeostat validate");
  const parts = partsFrom(opts.parts);
  const owner = ownerFor(config, opts.owner);
  const exclude = config.sources?.exclude.paths ?? [];
  const today = (io.now?.() ?? new Date()).toISOString().slice(0, 10);

  const plans = checkouts(config, root, opts, io).map((c) =>
    planRepo(config, files, c, parts, exclude, Boolean(opts.force)),
  );
  if (plans.length === 0)
    throw new CliError("no repo checkout found; pass --checkout <repo>=<path>");

  // The preview: every file each part reads, and what the model calls cost.
  const calls = plans.flatMap((p) => p.topics);
  const cost = estimate(calls, config.agents.curator.model);
  for (const p of plans) {
    io.stdout(`\n${p.label} (from ${p.checkout})\n`);
    for (const d of p.docs) io.stdout(`  doc   ${d.from} -> ${d.path}\n`);
    for (const t of p.topics) {
      io.stdout(`  model ${t.topic} -> ${t.path}: ${t.snapshot.files.length} files\n`);
      for (const f of t.snapshot.files) io.stdout(`          ${f.path}\n`);
    }
    for (const s of new Set(p.topics.map((t) => t.snapshot)))
      io.stdout(`  ${describeSnapshot(s)}\n`);
    for (const s of p.skipped) io.stdout(`  skip  ${s}\n`);
  }
  const dollars =
    cost.dollars === undefined ? "" : `, about $${cost.dollars.toFixed(2)} at API prices`;
  io.stdout(
    `\n${plans.reduce((n, p) => n + p.docs.length, 0)} documents to convert (no model); ${calls.length} model calls to ${config.agents.curator.model}: about ${cost.inputTokens} tokens in, ${cost.outputTokens} out${dollars}\n`,
  );

  if (opts.dryRun) {
    if (opts.prompts) {
      io.stdout(`\n--- system prompt ---\n${SEED_SYSTEM}\n`);
      for (const p of plans)
        for (const t of p.topics)
          io.stdout(
            `\n--- prompt for ${p.label} ${t.topic} ---\n${seedPrompt(t.snapshot, t.topic)}\n`,
          );
    }
    io.stdout("\ndry run: nothing sent, nothing written\n");
    return 0;
  }
  if (calls.length > 0 && !opts.yes) {
    if (!io.ask)
      throw new CliError("rerun with --yes to send the prompts, or --dry-run to look first");
    const answer = await io.ask(`Send ${calls.length} prompts to the model? [y/N]`);
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.stdout("nothing sent, nothing written\n");
      return 0;
    }
  }

  const seeder = io.seeder ?? new ClaudeSeeder(askerFor(config, "curator", io, root));
  let failed = false;
  for (const p of plans) {
    const changes: FileChange[] = [];
    const notes: string[] = [];
    for (const d of p.docs) {
      const raw = readFileSync(join(p.checkout, d.from), "utf8");
      const clean = redactSecrets(raw);
      if (clean.findings.length)
        notes.push(`${d.from}: ${clean.findings.length} secret(s) redacted`);
      const { text } = convertDoc(clean.text, {
        area: CORE_AREA,
        owner,
        scope: ["**"],
        today,
        fallbackTitle: basename(d.from).replace(/\.md$/i, "").replace(/[-_]/g, " "),
      });
      changes.push({ path: d.path, text, message: `homeostat: import ${d.from} from ${p.name}` });
    }
    for (const t of p.topics) {
      logEvent(root, {
        type: "seed-run",
        repo: p.name,
        topics: [t.topic],
        paths: t.snapshot.paths.length,
        chars: t.snapshot.files.reduce((n, f) => n + f.text.length, 0),
      });
      const draft = await seeder.draft(t.snapshot, t.topic);
      if (!draft) {
        notes.push(`${t.topic}: the model declined`);
        continue;
      }
      const text = seedDoc(draft, {
        area: CORE_AREA,
        owner,
        scope: ["**"],
        repo: p.name,
        today,
        source: "bootstrap",
      });
      changes.push({ path: t.path, text, message: `homeostat: draft ${t.path} from ${p.name}` });
    }

    // Only documents that validate are written; risk findings hold them for a person's read.
    const all = { ...files, ...Object.fromEntries(changes.map((c) => [c.path, c.text ?? ""])) };
    const issues = validate(all).issues.filter((i) => changes.some((c) => c.path === i.file));
    const blocking = issues.filter((i) => i.severity === "error" && !i.code.startsWith("risk."));
    const keep = changes.filter((c) => !blocking.some((i) => i.file === c.path));
    if (blocking.length) {
      io.stdout(
        `${p.label}: left out documents that do not validate:\n${formatIssues(blocking, io).text}`,
      );
      failed = true;
    }
    const risky = issues.filter((i) => i.code.startsWith("risk."));
    if (keep.length === 0) continue;
    await write(
      root,
      config,
      p,
      keep,
      notes,
      risky.map((i) => `${i.file}: ${i.message}`),
      today,
      io,
    );
  }
  return failed ? 1 : 0;
}

function partsFrom(given: string[] | undefined): BootstrapPart[] {
  const parts = given?.flatMap((p) => p.split(",")).filter(Boolean) ?? [...BOOTSTRAP_PARTS];
  for (const p of parts)
    if (!(BOOTSTRAP_PARTS as readonly string[]).includes(p))
      throw new CliError(`unknown part "${p}"; use ${BOOTSTRAP_PARTS.join(", ")}`);
  return parts as BootstrapPart[];
}

function ownerFor(config: Config, given: string | undefined): string {
  const members = config.team.members;
  if (given) {
    if (!members.some((m) => m.id === given)) throw new CliError(`${given} is not a team member`);
    return given;
  }
  const owner =
    config.team.reviewers?.[0] ?? members.find((m) => m.role === "lead")?.id ?? members[0]?.id;
  if (!owner) throw new CliError("add a team member first: documents need an owner");
  return owner;
}

/** Each repo's checkout: given with --checkout, else a folder next to the KB or here whose remote matches. */
function checkouts(
  config: Config,
  root: string,
  opts: BootstrapOptions,
  io: Io,
): { repo: string | undefined; dir: string }[] {
  const given = new Map<string, string>();
  for (const c of opts.checkout ?? []) {
    const [name, path] = c.includes("=") ? c.split(/=(.*)/s) : ["", c];
    given.set(name ?? "", resolve(path ?? ""));
  }
  if (!config.repos) {
    const dir = given.get("") ?? [...given.values()][0];
    if (!dir) throw new CliError("this KB has no repos: pass --checkout <path> to the code repo");
    return [{ repo: undefined, dir }];
  }
  const names = repoNames(config).filter((r) => !opts.repo?.length || opts.repo.includes(r));
  for (const r of opts.repo ?? [])
    if (!repoNames(config).includes(r)) throw new CliError(`unknown repo "${r}"`);
  const candidates = [
    ...new Set(
      [dirname(root), process.cwd(), dirname(process.cwd())].flatMap((d) => [d, ...subdirs(d)]),
    ),
  ];
  const remotes = new Map(
    candidates
      .filter((d) => existsSync(join(d, ".git")))
      .map((d) => [d, remoteRepo(git(d, "remote", "get-url", "origin") ?? "")] as const),
  );
  const out: { repo: string; dir: string }[] = [];
  for (const name of names) {
    const source = config.repos[name]?.source.toLowerCase();
    const dir =
      given.get(name) ??
      [...remotes].find(([, r]) => r === source)?.[0] ??
      [...remotes.keys()].find((d) => basename(d).toLowerCase() === name);
    if (dir) out.push({ repo: name, dir });
    else io.stdout(`skip ${name}: no checkout found; pass --checkout ${name}=<path>\n`);
  }
  return out;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function planRepo(
  config: Config,
  files: Record<string, string>,
  c: { repo: string | undefined; dir: string },
  parts: BootstrapPart[],
  exclude: readonly string[],
  force: boolean,
): Plan {
  const listed = git(c.dir, "ls-files");
  if (listed === undefined) throw new CliError(`${c.dir} is not a git checkout`);
  const tracked = listed.split("\n").filter(Boolean);
  const name =
    c.repo ?? basename(remoteRepo(git(c.dir, "remote", "get-url", "origin") ?? "") ?? c.dir);
  const label = c.repo ?? name;
  const taken = new Set<string>();
  const skipped: string[] = [];
  const free = (path: string) => {
    if (taken.has(path)) return false;
    if (files[path] !== undefined && !force) {
      skipped.push(`${path}: already in the KB (--force replaces)`);
      return false;
    }
    taken.add(path);
    return true;
  };
  const target = (topic: string) => docFilePath(config, { repo: c.repo, area: CORE_AREA, topic });

  // Human-written documents first: a model draft never replaces one the repo already has.
  const docs = parts.includes("docs")
    ? existingDocs(tracked, exclude)
        .map((from) => ({ from, path: target(docTopic(from)) }))
        .filter((d) => free(d.path))
    : [];

  const wanted = parts.flatMap((p) => (p === "docs" ? [] : PART_TOPICS[p]));
  const snapshots = snapshotsFor(c.dir, name, listed, wanted, exclude);
  const topics: Plan["topics"] = [];
  for (const topic of wanted) {
    const snapshot = snapshotOf(snapshots, topic);
    if ((topic === "data" || topic === "infrastructure") && snapshot.files.length === 0) {
      skipped.push(
        `${topic}: no ${topic === "data" ? "migrations, models or schema files" : "deploy manifests"} found`,
      );
      continue;
    }
    const path = target(topic);
    if (!free(path)) {
      if (docs.some((d) => d.path === path))
        skipped.push(`${topic}: the repo already has this document`);
      continue;
    }
    topics.push({ topic, path, snapshot });
  }
  return { repo: c.repo, label, checkout: c.dir, name, docs, topics, skipped };
}

async function write(
  root: string,
  config: Config,
  p: Plan,
  changes: FileChange[],
  notes: string[],
  risky: string[],
  today: string,
  io: Io,
): Promise<void> {
  if (config.sources && git(root, "remote", "get-url", "origin") !== undefined) {
    const [owner = "", name = ""] = config.sources.kbRepo.split("/");
    const kbRepo: RepoRef = { owner, name };
    const read = [...new Set(p.topics.flatMap((t) => t.snapshot.files.map((f) => f.path)))];
    await publish({
      root,
      branch: `homeostat/bootstrap-${p.label}-${today}`,
      changes,
      provider: providerFor(config.sources.host, io, "open the bootstrap PR"),
      kbRepo,
      base: config.sources.baseBranch,
      title: `homeostat: first base for ${p.label}`,
      body: [
        `Built by \`homeostat bootstrap\` from a checkout of ${p.name}.`,
        "",
        ...(p.docs.length
          ? [
              "**Imported as they are:**",
              ...p.docs.map((d) => `- \`${d.from}\` as \`${d.path}\``),
              "",
            ]
          : []),
        ...(p.topics.length
          ? [
              "**Drafted by the model** (every section marked `source=bootstrap` with its confidence):",
              ...p.topics.map((t) => `- ${t.topic}: \`${t.path}\``),
              "",
              `Files sent: ${read.map((f) => `\`${f}\``).join(", ")}.`,
              "",
            ]
          : []),
        "Correct anything wrong before merging: other agents will treat it as fact.",
        ...(notes.length ? ["", ...notes.map((n) => `- ${n}`)] : []),
        ...(risky.length ? ["", "**Needs a careful read:**", ...risky.map((r) => `- ${r}`)] : []),
      ].join("\n"),
      io,
    });
  } else {
    for (const c of changes) {
      const full = join(root, ...c.path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, c.text ?? "");
      io.stdout(`wrote ${c.path}\n`);
    }
    io.stdout("review them, then commit on a branch and open a PR\n");
  }
  for (const n of [...notes, ...risky]) io.stdout(`  ${n}\n`);
}
