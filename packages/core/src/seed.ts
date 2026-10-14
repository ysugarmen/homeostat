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
} as const;
export type SeedTopic = keyof typeof SEED_TOPICS;

export interface RepoSnapshot {
  name: string;
  /** Tracked paths, after exclusions. */
  paths: string[];
  /** Key files' text (README, manifests, configs), after exclusions and redaction. */
  files: { path: string; text: string }[];
  redacted: number;
}

const KEY_FILE =
  /(^|\/)(README(\.\w+)?|CONTRIBUTING\.md|ARCHITECTURE\.md|package\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg|requirements\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|docker-compose\.ya?ml|Dockerfile|Makefile|tsconfig\.json|\.env\.example)$/i;
const MAX_PATHS = 400;
const MAX_FILE_BYTES = 6_000;
const MAX_TOTAL_BYTES = 60_000;

/**
 * Picks what a seed run may send: the tracked paths (capped) and a few key files, shallowest
 * first, each cut to size and redacted. `read` returns a tracked file's text.
 */
export function snapshotRepo(
  name: string,
  tracked: readonly string[],
  read: (path: string) => string | undefined,
  exclude: readonly string[],
): RepoSnapshot {
  const allowed = tracked.filter((p) => !exclude.some((g) => minimatch(p, g, { dot: true })));
  const depth = (p: string) => p.split("/").length;
  const readme = (p: string) => Number(/(^|\/)README/i.test(p));
  const keys = allowed
    .filter((p) => KEY_FILE.test(p))
    // Shallowest first, READMEs before other files at the same depth: they say the most.
    .sort((a, b) => depth(a) - depth(b) || readme(b) - readme(a) || a.localeCompare(b));
  const files: RepoSnapshot["files"] = [];
  let total = 0;
  let redacted = 0;
  for (const path of keys) {
    if (total >= MAX_TOTAL_BYTES) break;
    const raw = read(path);
    if (raw === undefined) continue;
    const cut = raw.length > MAX_FILE_BYTES ? `${raw.slice(0, MAX_FILE_BYTES)}\n[cut]` : raw;
    const r = redactSecrets(cut);
    redacted += r.findings.length;
    files.push({ path, text: r.text });
    total += r.text.length;
  }
  return { name, paths: allowed.slice(0, MAX_PATHS), files, redacted };
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

Key files:

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
  opts: { area: string; owner: string; scope: string[]; repo: string; today: string },
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
          source: "seed",
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
