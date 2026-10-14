import { parseDocument, stringify } from "yaml";
import { type BodySections, parseBody } from "./body.ts";
import { error, type Issue } from "./issues.ts";
import { type Frontmatter, frontmatterSchema } from "./schema.ts";
import { fromZod } from "./zod-issues.ts";

export interface Entry {
  frontmatter: Frontmatter;
  /** Markdown after the frontmatter, trimmed. This is what `tokens` counts. */
  body: string;
  sections: BodySections;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Rules that span several frontmatter fields but need no config. */
function crossFieldIssues(fm: Frontmatter): Issue[] {
  const issues: Issue[] = [];
  if (fm.adopted !== undefined && fm.kind !== "decision") {
    issues.push(
      error("adopted.kind", "adopted: only applies to kind: decision", { path: "adopted" }),
    );
  }
  if (fm.kind === "decision" && fm.adopted === undefined) {
    issues.push(
      error(
        "adopted.required",
        "adopted: required for kind: decision (true if the team adopted it, false if not)",
        {
          path: "adopted",
        },
      ),
    );
  }
  if (fm.source.type === "pr-feedback") {
    if (!fm.source.url) {
      issues.push(
        error("source.url.required", "source.url: required when source.type is pr-feedback", {
          path: "source.url",
        }),
      );
    }
    if (fm.source.changedCode === undefined) {
      issues.push(
        error(
          "source.changedCode.required",
          "source.changedCode: required when source.type is pr-feedback",
          { path: "source.changedCode" },
        ),
      );
    }
  }
  if (fm.conflictsWith?.length && fm.status !== "disputed") {
    issues.push(
      error("conflicts.notDisputed", `status: must be "disputed" while conflictsWith is set`, {
        path: "status",
      }),
    );
  }
  if (fm.conflictsWith?.includes(fm.id)) {
    issues.push(
      error("conflicts.self", "conflictsWith: an entry cannot conflict with itself", {
        path: "conflictsWith",
      }),
    );
  }
  if (fm.supersedes === fm.id) {
    issues.push(
      error("supersedes.self", "supersedes: an entry cannot supersede itself", {
        path: "supersedes",
      }),
    );
  }
  return issues;
}

/**
 * Parses one entry file. Returns `entry` whenever the frontmatter has a valid shape, so callers
 * can still run further checks; `issues` holds every problem found, including body problems.
 */
export function parseEntry(text: string): { entry?: Entry; issues: Issue[] } {
  const match = FRONTMATTER.exec(text);
  if (!match) {
    return {
      issues: [error("frontmatter.missing", "file must start with a --- YAML frontmatter block")],
    };
  }
  const [, yamlText = "", rest = ""] = match;

  const doc = parseDocument(yamlText);
  if (doc.errors.length) {
    return {
      issues: doc.errors.map((e) => error("frontmatter.yaml", `invalid YAML: ${e.message}`)),
    };
  }

  const body = rest.trim();
  const { sections, issues } = parseBody(body);
  const parsed = frontmatterSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    return {
      issues: [
        ...fromZod(parsed.error, { code: "schema", renamed: { vertical: "area" } }),
        ...issues,
      ],
    };
  }

  issues.unshift(...crossFieldIssues(parsed.data));
  return { entry: { frontmatter: parsed.data, body, sections }, issues };
}

/** Serializes an entry to its file form; `parseEntry(formatEntry(fm, body))` round-trips. */
export function formatEntry(frontmatter: Frontmatter, body: string): string {
  return `---\n${stringify(frontmatter)}---\n\n${body.trim()}\n`;
}
