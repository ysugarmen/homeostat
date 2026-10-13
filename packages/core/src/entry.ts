import { parseDocument } from "yaml";
import type { z } from "zod";
import { type BodySections, parseBody } from "./body.ts";
import { error, type Issue } from "./issues.ts";
import { type Frontmatter, frontmatterSchema } from "./schema.ts";

export interface Entry {
  frontmatter: Frontmatter;
  /** Markdown after the frontmatter, trimmed. This is what `tokens` counts. */
  body: string;
  sections: BodySections;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

const RENAMED_FIELDS: Record<string, string> = { vertical: "area" };

function schemaIssues(error_: z.ZodError): Issue[] {
  return error_.issues.flatMap((i): Issue[] => {
    if (i.code === "unrecognized_keys") {
      return i.keys.map((key) => {
        const path = [...i.path, key].join(".");
        const hint = RENAMED_FIELDS[key] ? `; did you mean "${RENAMED_FIELDS[key]}"?` : "";
        return error("schema", `${path}: unknown field${hint}`, { path });
      });
    }
    const path = i.path.join(".");
    const missing = i.code === "invalid_type" && /received undefined/.test(i.message);
    return [error("schema", `${path}: ${missing ? "is required" : i.message}`, { path })];
  });
}

/** Rules that span several frontmatter fields but need no config. */
function crossFieldIssues(fm: Frontmatter): Issue[] {
  const issues: Issue[] = [];
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
    return { issues: [...schemaIssues(parsed.error), ...issues] };
  }

  issues.unshift(...crossFieldIssues(parsed.data));
  return { entry: { frontmatter: parsed.data, body, sections }, issues };
}
