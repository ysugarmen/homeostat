import { minimatch } from "minimatch";
import { z } from "zod";
import type { Asker } from "./claude.ts";
import { type Doc, formatDoc } from "./doc.ts";
import { redactSecrets } from "./secrets.ts";
import { slugify } from "./slug.ts";

/**
 * `homeostat seed`: drafts a new team's first documents from a scan of one repository (Phase K,
 * K5). This is the one feature that sends source code to a model, so it only ever runs by hand,
 * never on a schedule, honours `sources.exclude.paths`, redacts secrets, and can print its prompts
 * without sending anything.
 */

export const SEED_TOPICS = {
  architecture:
    "Architecture: the services or modules, what each is for, how they call each other, where data lives, and the main entry points.",
  conventions:
    "Conventions: how code here is laid out and written: directory layout, naming, error handling, testing, configuration.",
  "cross-repo":
    "Cross-repo contracts: what this repository exposes to or needs from other repositories (APIs, events, shared packages, schemas).",
  data: "Data: one section per database or schema the repository owns: its tables and key columns, how they relate, which service or module writes each, and how the repository creates, tests and deploys migrations. Summarise the current schema; do not list every migration.",
  infrastructure:
    "Infrastructure: the services and jobs this repository deploys, where each runs (cluster, cloud, region when shown), how they reach each other, how each is built and deployed (images, charts, pipelines), and scheduled jobs. Work from the manifests only.",
} as const;
export type SeedTopic = keyof typeof SEED_TOPICS;

export interface RepoSnapshot {
  name: string;
  /** Tracked paths, after exclusions. */
  paths: string[];
  /** Key files' text (README, manifests, configs), after exclusions and redaction. */
  files: { path: string; text: string }[];
  redacted: number;
  /** Files left out because they hold secrets (Secret manifests, files full of credentials). */
  skipped: number;
}

/**
 * Never read, whatever the topic: Terraform state, env files, keys and certificates. Kubernetes
 * `Secret` manifests are recognised by their text (see `isSecretManifest`).
 */
export const NEVER_READ = [
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/.terraform/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.tfvars",
  "**/*secret*",
  "**/secrets/**",
];

/** A file with this many secret findings is a secrets file: left out, not redacted and sent. */
export const SECRETS_FILE_FINDINGS = 3;

/** A Kubernetes Secret or SealedSecret manifest: never sent, even when its name looks harmless. */
export const isSecretManifest = (text: string) =>
  /^\s*kind:\s*["']?(Secret|SealedSecret)["']?\s*$/m.test(text);

const VENDORED = /(^|\/)(node_modules|vendor|dist|build|\.venv|venv|site-packages|\.git)\//;
/** Tests describe the code, not the schema or the deploy: never picked. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|fixtures?)\/|(^|\/)test_[^/]+$|[._-](test|spec)\.[^/]+$/;

/** Which files a topic reads: a test, a ranking (lower first), and size limits. */
export interface FilePicker {
  match: (path: string) => boolean;
  rank?: (path: string) => number;
  /** Within a rank, later names first: migrations are named by date or revision. */
  newestFirst?: boolean;
  /** The most of `maxTotalBytes` one rank may fill, so models leave room for migrations. */
  rankShare?: number;
  /** A last test on a picked file's text; false leaves it out. */
  accept?: (path: string, text: string) => boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
}

const KEY_FILE =
  /(^|\/)(README(\.\w+)?|CONTRIBUTING\.md|ARCHITECTURE\.md|package\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|docker-compose\.ya?ml|Dockerfile|Makefile|tsconfig\.json)$/i;
const MAX_PATHS = 400;

const depth = (p: string) => p.split("/").length;

/** The key files that say how a repo is laid out: READMEs, manifests, build files. */
export const KEY_FILES: FilePicker = {
  match: (p) => KEY_FILE.test(p),
  // READMEs before other files at the same depth: they say the most.
  rank: (p) => depth(p) * 2 - Number(/(^|\/)README/i.test(p)),
  maxFileBytes: 6_000,
  maxTotalBytes: 60_000,
};

const SCHEMA_DUMP = /(^|\/)(schema\.(sql|rb|prisma|graphql)|structure\.sql|.*\.dbml)$/i;
const ORM_MODEL =
  /(^|\/)(models?\.py|models\/[^/]+\.py|entities\/[^/]+\.(ts|java|kt|py)|.*\.entity\.ts|.*Entity\.(java|kt)|schema\/[^/]+\.ts)$/;
const MIGRATION =
  /(^|\/)(alembic\/(env\.py|versions\/[^/]+\.py)|alembic\.ini|migrations\/.+\.(sql|py|ts|js)|db\/migrate\/[^/]+\.rb|flyway\/.+\.sql|V\d+[^/]*__[^/]+\.sql|liquibase\/.+\.(xml|ya?ml|sql))$/;
const DDL = /\.sql$/i;
/** Code in a folder that usually holds table definitions; kept only if its text defines one. */
const MAYBE_ORM =
  /(^|\/)(sql|db|database|orm|mappers?|models?|entities|tables|persistence|repositories)\/(.+\/)?[^/]+\.(py|ts|js|java|kt|rb|go|cs)$/;
const ORM_TEXT =
  /__tablename__|\bTable\(\s*["']|mapped_column\(|\bColumn\(|@Entity\b|@Table\b|CREATE TABLE|createTable\(|pgTable\(|sequelize\.define|gorm\.Model/;

/**
 * Database schemas: dumps and ORM models first (they show the current shape), then migration
 * setup and the newest migrations (names sort by date or revision in every common tool).
 */
export const DATA_FILES: FilePicker = {
  match: (p) =>
    SCHEMA_DUMP.test(p) ||
    ORM_MODEL.test(p) ||
    MAYBE_ORM.test(p) ||
    MIGRATION.test(p) ||
    DDL.test(p),
  rank: (p) =>
    SCHEMA_DUMP.test(p)
      ? 0
      : MIGRATION.test(p) && !/alembic\.ini|env\.py$/.test(p)
        ? 3
        : ORM_MODEL.test(p) || MAYBE_ORM.test(p)
          ? 1
          : /alembic\.ini|env\.py$/.test(p)
            ? 2
            : 4,
  newestFirst: true,
  rankShare: 0.5,
  // Migrations and dumps are schema by definition; other code only when it defines a table.
  accept: (p, text) =>
    SCHEMA_DUMP.test(p) || MIGRATION.test(p) || /alembic\.ini$/.test(p) || ORM_TEXT.test(text),
  maxFileBytes: 8_000,
  maxTotalBytes: 80_000,
};

const INFRA =
  /(^|\/)(Chart\.ya?ml|values[^/]*\.ya?ml|templates\/[^/]+\.ya?ml|kustomization\.ya?ml|[^/]+\.tf|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|skaffold\.ya?ml|cloudbuild\.ya?ml|app\.ya?ml|serverless\.ya?ml|bitbucket-pipelines\.yml|\.gitlab-ci\.yml|Jenkinsfile|Procfile|fly\.toml|\.github\/workflows\/[^/]+\.ya?ml)$/;
const K8S_DIR =
  /(^|\/)(k8s|kubernetes|manifests|deploy|deployment|helm|charts|infra|ops)\/.+\.ya?ml$/;

/** Deploy manifests: chart and pipeline files first, then Terraform and raw manifests. */
export const INFRA_FILES: FilePicker = {
  match: (p) => INFRA.test(p) || K8S_DIR.test(p),
  rank: (p) =>
    /Chart\.ya?ml|pipelines\.yml|workflows\/|gitlab-ci|cloudbuild|skaffold|docker-compose/.test(p)
      ? 0
      : /values[^/]*\.ya?ml|Dockerfile/.test(p)
        ? 1
        : 2,
  rankShare: 0.5,
  maxFileBytes: 6_000,
  maxTotalBytes: 80_000,
};

/** The files each seed topic reads. */
export const SEED_PICKERS: Record<SeedTopic, FilePicker> = {
  architecture: KEY_FILES,
  conventions: KEY_FILES,
  "cross-repo": KEY_FILES,
  data: DATA_FILES,
  infrastructure: INFRA_FILES,
};

/**
 * Picks what a seed run may send: the tracked paths (capped) and the files `pick` chooses, best
 * ranked first, each cut to size and redacted. Never-read files, vendored folders and Secret
 * manifests are left out. `read` returns a tracked file's text.
 */
export function snapshotRepo(
  name: string,
  tracked: readonly string[],
  read: (path: string) => string | undefined,
  exclude: readonly string[],
  pick: FilePicker = KEY_FILES,
): RepoSnapshot {
  const never = [...NEVER_READ, ...exclude];
  const allowed = tracked.filter((p) => !never.some((g) => minimatch(p, g, { dot: true })));
  const rank = pick.rank ?? depth;
  const candidates = allowed.filter(
    (p) => !VENDORED.test(p) && !TEST_PATH.test(p) && pick.match(p),
  );
  const picked = pick.newestFirst
    ? interleaved(candidates, rank)
    : candidates.sort((a, b) => rank(a) - rank(b) || depth(a) - depth(b) || a.localeCompare(b));
  const files: RepoSnapshot["files"] = [];
  let total = 0;
  let redacted = 0;
  let skipped = 0;
  const perRank = new Map<number, number>();
  const share = (pick.rankShare ?? 1) * pick.maxTotalBytes;
  for (const path of picked) {
    if (total >= pick.maxTotalBytes) break;
    const r0 = rank(path);
    if ((perRank.get(r0) ?? 0) >= share) continue;
    const raw = read(path);
    if (raw === undefined) continue;
    if (pick.accept && !pick.accept(path, raw)) continue;
    if (/\.ya?ml$/i.test(path) && isSecretManifest(raw)) {
      skipped++;
      continue;
    }
    const cut = raw.length > pick.maxFileBytes ? `${raw.slice(0, pick.maxFileBytes)}\n[cut]` : raw;
    const r = redactSecrets(cut);
    if (r.findings.length >= SECRETS_FILE_FINDINGS) {
      skipped++;
      continue;
    }
    redacted += r.findings.length;
    files.push({ path, text: r.text });
    total += r.text.length;
    perRank.set(r0, (perRank.get(r0) ?? 0) + r.text.length);
  }
  return { name, paths: allowed.slice(0, MAX_PATHS), files, redacted, skipped };
}

/**
 * By rank, then one file from each folder in turn, newest first within a folder: two migration
 * histories both get their latest files, rather than the first folder taking the whole budget.
 */
function interleaved(paths: readonly string[], rank: (p: string) => number): string[] {
  const out: string[] = [];
  for (const r of [...new Set(paths.map(rank))].sort((a, b) => a - b)) {
    const folders = new Map<string, string[]>();
    for (const p of paths.filter((x) => rank(x) === r).sort((a, b) => b.localeCompare(a))) {
      const dir = p.slice(0, p.lastIndexOf("/") + 1);
      folders.set(dir, [...(folders.get(dir) ?? []), p]);
    }
    const queues = [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, q]) => q);
    while (queues.some((q) => q.length))
      for (const q of queues) if (q.length) out.push(q.shift() as string);
  }
  return out;
}

export const SEED_SYSTEM = `You write the first version of a software team's reference documents from a snapshot of one repository: its file tree and a few key files. Other engineers and AI coding agents will rely on what you write, so state only what the snapshot shows. When something is unclear, leave it out rather than guess.

Write short sections, each about one thing, under 250 words, in plain sentences. Name real paths, packages and commands from the snapshot. Never include secrets, credentials, internal hostnames or personal data, even if they appear in the files.`;

export function seedPrompt(snapshot: RepoSnapshot, topic: SeedTopic): string {
  const files = snapshot.files
    .map((f) => `<file path="${f.path}">\n${f.text}\n</file>`)
    .join("\n\n");
  return `Repository: ${snapshot.name}
Document to write: ${SEED_TOPICS[topic]}

File tree (${snapshot.paths.length} paths${snapshot.paths.length >= MAX_PATHS ? ", cut" : ""}):
${snapshot.paths.join("\n")}

Files (${snapshot.files.length}):

${files}`;
}

export const seedSchema = z.object({
  title: z.string().describe("the document title, at most 80 characters"),
  intro: z.string().describe("one or two sentences: what this document covers"),
  sections: z
    .array(
      z.object({
        heading: z.string().describe("short heading"),
        body: z.string().describe("the section text, under 250 words"),
        confidence: z
          .enum(["high", "medium", "low"])
          .describe("how directly the snapshot shows this"),
      }),
    )
    .describe("3 to 8 sections"),
});
export type SeedDraft = z.infer<typeof seedSchema>;

/** Drafts one document; null when the model declines. */
export interface Seeder {
  draft(snapshot: RepoSnapshot, topic: SeedTopic): Promise<SeedDraft | null>;
}

export class ClaudeSeeder implements Seeder {
  private readonly ask: Asker;
  constructor(ask: Asker) {
    this.ask = ask;
  }
  draft(snapshot: RepoSnapshot, topic: SeedTopic): Promise<SeedDraft | null> {
    return this.ask(SEED_SYSTEM, seedPrompt(snapshot, topic), seedSchema);
  }
}

/** Turns a draft into a document file with `source=seed` provenance on every section. */
export function seedDoc(
  draft: SeedDraft,
  opts: {
    area: string;
    owner: string;
    scope: string[];
    repo: string;
    today: string;
    source?: "seed" | "bootstrap";
  },
): string {
  const used = new Set<string>();
  const doc: Doc = {
    frontmatter: {
      title: draft.title.slice(0, 80),
      area: opts.area,
      owner: opts.owner,
      scope: opts.scope,
      updated: opts.today,
    },
    intro: draft.intro.trim(),
    sections: draft.sections.map((s) => {
      const base = slugify(s.heading) ?? "section";
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base.slice(0, 56)}-${n}`;
      used.add(id);
      return {
        id,
        heading: s.heading.trim(),
        line: 0,
        provenance: {
          source: opts.source ?? "seed",
          updated: opts.today,
          confidence: s.confidence,
          note: `scan of ${opts.repo}`,
        },
        body: s.body.trim(),
      };
    }),
  };
  return formatDoc(doc);
}
