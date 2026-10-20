import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { error, type Issue } from "./issues.ts";
import { ID_PATTERN } from "./schema.ts";
import { slugify } from "./slug.ts";
import { fromZod } from "./zod-issues.ts";

/**
 * Knowledge documents: the team's living reference (architecture, cross-repo contracts,
 * migrations, domain guides), next to the atomic rules. They live at
 * `knowledge/<area>/docs/<topic>.md`, split into `## Heading {#id}` sections, each carrying its
 * own provenance, so agents read and patch one section at a time (Phase K, K1).
 */

export const DOC_SECTION_MAX_WORDS = 400;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

export const docFrontmatterSchema = z.strictObject({
  title: z.string().min(1).max(80),
  area: z.string().min(1),
  owner: z.string().min(1),
  /** The code paths this document describes; sessions touching them see it. */
  scope: z
    .array(z.string().min(1))
    .min(1, 'must list at least one path glob; use ["**"] for global'),
  updated: isoDate,
  tags: z.array(z.string().min(1)).optional(),
  /** A member who read this document's risky-content findings and judged it safe. */
  riskReviewedBy: z.string().min(1).optional(),
});
export type DocFrontmatter = z.infer<typeof docFrontmatterSchema>;

export const PROVENANCE_SOURCES = [
  "pr-feedback",
  "manual",
  "agent-handoff",
  "deep-dive",
  "curator",
  "seed",
  "bootstrap",
  "imported",
] as const;

export interface Provenance {
  source: string;
  /** Member who wrote or approved this text, when it was not a review thread. */
  author?: string;
  url?: string;
  updated?: string;
  confidence?: "high" | "medium" | "low";
  note?: string;
}

export interface DocSection {
  id: string;
  heading: string;
  /** 1-based line of the heading in the file. */
  line: number;
  provenance?: Provenance;
  /** The section's text after the heading and provenance comment, trimmed. */
  body: string;
}

export interface Doc {
  frontmatter: DocFrontmatter;
  /** Text before the first section (a short summary), trimmed. */
  intro: string;
  sections: DocSection[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const HEADING = /^##[ \t]+(.+?)(?:[ \t]+\{#([^}\s]+)\})?[ \t]*$/;
const PROVENANCE = /^<!--\s*homeostat:\s*(.*?)\s*-->$/;

/** `key=value key="quoted value"` pairs from a provenance comment. */
export function parseProvenance(text: string): Provenance | undefined {
  const pairs = Object.fromEntries(
    [...text.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)].map((m) => [m[1], m[2] ?? m[3] ?? ""]),
  );
  if (!pairs.source) return undefined;
  return pairs as unknown as Provenance;
}

export function formatProvenance(p: Provenance): string {
  const parts = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) =>
      /[\s"]/.test(String(v)) ? `${k}="${String(v).replace(/"/g, "'")}"` : `${k}=${v}`,
    );
  return `<!-- homeostat: ${parts.join(" ")} -->`;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Splits a document body into its intro and `##` sections, outside code fences. */
function splitSections(body: string, firstLine: number): { intro: string; sections: DocSection[] } {
  const lines = body.split("\n");
  const sections: DocSection[] = [];
  const intro: string[] = [];
  let current: { section: DocSection; lines: string[] } | undefined;
  let fence = false;
  const close = () => {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    const first = text.split("\n")[0]?.trim() ?? "";
    const prov = PROVENANCE.exec(first);
    if (prov) {
      const p = parseProvenance(prov[1] ?? "");
      if (p) current.section.provenance = p;
      current.section.body = text.slice(first.length).trim();
    } else current.section.body = text;
    sections.push(current.section);
  };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : HEADING.exec(line);
    if (h) {
      close();
      const heading = (h[1] ?? "").trim();
      current = {
        section: { id: h[2] ?? "", heading, line: firstLine + i, body: "" },
        lines: [],
      };
    } else if (current) current.lines.push(line);
    else intro.push(line);
  });
  close();
  return { intro: intro.join("\n").trim(), sections };
}

/** Parses and checks one document. `doc` is returned whenever the frontmatter has a valid shape. */
export function parseDoc(text: string): { doc?: Doc; issues: Issue[] } {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return {
      issues: [
        error(
          "doc.frontmatter.missing",
          "document must start with a --- frontmatter block (title, area, owner, scope, updated); homeostat docs convert adds one",
        ),
      ],
    };
  }
  const [, yamlText = "", rest = ""] = match;
  const yaml = parseDocument(yamlText);
  if (yaml.errors.length) {
    return {
      issues: yaml.errors.map((e) => error("doc.frontmatter.yaml", `invalid YAML: ${e.message}`)),
    };
  }
  const firstLine = yamlText.split("\n").length + 3;
  const issues = bodyIssues(rest, firstLine);
  const { intro, sections } = splitSections(rest.replace(/^\s*\n/, ""), firstLine);
  issues.push(...sectionIssues(sections));

  const parsed = docFrontmatterSchema.safeParse(yaml.toJS());
  if (!parsed.success) {
    return { issues: [...fromZod(parsed.error, { code: "doc.schema" }), ...issues] };
  }
  return { doc: { frontmatter: parsed.data, intro, sections }, issues };
}

/** Problems in the raw body: the pilot's recurring damage from whole-file rewrites. */
function bodyIssues(body: string, firstLine: number): Issue[] {
  const issues: Issue[] = [];
  const lines = body.split("\n");
  const trimmed = body.trim();
  if (/^(```|~~~)/.test(trimmed) && /(```|~~~)$/.test(trimmed)) {
    issues.push(
      error(
        "doc.fence.wrapped",
        "the whole document is wrapped in a code fence, so it renders as code; remove the outer fence",
      ),
    );
  }
  const fences = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2 === 1) {
    issues.push(
      error(
        "doc.fence.unclosed",
        "a code fence is never closed; everything after it renders as code",
      ),
    );
  }
  const conflict = lines.findIndex((l) => /^(<{7}|={7}|>{7})( |$)/.test(l));
  if (conflict >= 0) {
    issues.push(
      error("doc.conflict-marker", `merge conflict marker on line ${firstLine + conflict}`),
    );
  }
  const updated = lines
    .map((l, i) => [l, i] as const)
    .filter(([l]) => /^\s*(<!--\s*)?(\*\*)?last updated:?/i.test(l));
  if (updated.length) {
    issues.push({
      code: updated.length > 1 ? "doc.updated.repeated" : "doc.updated.inline",
      severity: updated.length > 1 ? "error" : "warning",
      message: `${updated.length > 1 ? `${updated.length} "Last updated" lines` : 'a "Last updated" line'} (line ${updated.map(([, i]) => firstLine + i).join(", ")}): dates belong in the frontmatter's updated and each section's provenance`,
    });
  }
  const h1 = lines.filter((l) => /^#\s/.test(l)).length;
  if (h1) {
    issues.push({
      code: "doc.heading.h1",
      severity: "warning",
      message: "a # heading in the body; the title lives in the frontmatter, sections start at ##",
    });
  }
  return issues;
}

function sectionIssues(sections: DocSection[]): Issue[] {
  const issues: Issue[] = [];
  const ids = new Map<string, number>();
  const headings = new Map<string, number>();
  for (const s of sections) {
    const where = `line ${s.line}`;
    if (!s.id) {
      issues.push({
        code: "doc.section.id.missing",
        severity: "warning",
        message: `section "${s.heading}" (${where}) has no {#id}; add {#${slugify(s.heading) ?? "id"}} so it stays addressable when its heading changes`,
      });
    } else if (!ID_PATTERN.test(s.id)) {
      issues.push(
        error(
          "doc.section.id.invalid",
          `section id "${s.id}" (${where}) must be lowercase letters, digits and single hyphens`,
        ),
      );
    } else if (ids.has(s.id)) {
      issues.push(
        error(
          "doc.section.id.duplicate",
          `section id "${s.id}" is used on lines ${ids.get(s.id)} and ${s.line}`,
        ),
      );
    }
    if (s.id) ids.set(s.id, ids.get(s.id) ?? s.line);
    const key = s.heading.toLowerCase();
    if (headings.has(key)) {
      issues.push(
        error(
          "doc.section.heading.duplicate",
          `heading "${s.heading}" appears on lines ${headings.get(key)} and ${s.line}; merge the two sections`,
        ),
      );
    } else headings.set(key, s.line);
    if (!s.body) {
      issues.push({
        code: "doc.section.empty",
        severity: "warning",
        message: `section "${s.heading}" (${where}) is empty`,
      });
    }
    const n = words(s.body);
    if (n > DOC_SECTION_MAX_WORDS) {
      issues.push({
        code: "doc.section.too-long",
        severity: "warning",
        message: `section "${s.heading}" (${where}) has ${n} words (max ${DOC_SECTION_MAX_WORDS}); split it so agents can read just the part they need`,
      });
    }
    if (s.provenance && !(PROVENANCE_SOURCES as readonly string[]).includes(s.provenance.source)) {
      issues.push(
        error(
          "doc.provenance.source",
          `section "${s.heading}" (${where}): unknown provenance source "${s.provenance.source}"`,
        ),
      );
    }
  }
  return issues;
}

/** Serializes a document; `parseDoc(formatDoc(doc))` round-trips. */
export function formatDoc(doc: Doc): string {
  const sections = doc.sections.map((s) =>
    [
      `## ${s.heading} {#${s.id}}`,
      ...(s.provenance ? [formatProvenance(s.provenance)] : []),
      s.body,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return `---\n${stringify(doc.frontmatter)}---\n\n${[doc.intro, ...sections].filter(Boolean).join("\n\n")}\n`;
}

/** Whether a KB-relative path is a document rather than an atomic entry. */
/** `knowledge/<area>/docs/…`, or `knowledge/<repo>/<area>/docs/…` in a multi-repo KB. */
export const isDocPath = (path: string) =>
  /^knowledge\/(?:[^/]+\/)?[^/]+\/docs\/[^/]+\.md$/.test(path);
