import { stringify } from "yaml";
import type { Fix } from "./issues.ts";

const FRONTMATTER = /^(---\r?\n)([\s\S]*?\r?\n)(---[ \t]*(?:\r?\n|$)[\s\S]*)$/;

/**
 * Writes fixes into an entry file's frontmatter by replacing only the lines of the fixed
 * top-level fields, so comments, quoting and key order stay exactly as they were.
 */
export function applyFixes(text: string, fixes: readonly Fix[]): string {
  const match = FRONTMATTER.exec(text);
  if (!match || fixes.length === 0) return text;
  let [, open = "", yaml = "", rest = ""] = match;

  for (const { field, value } of fixes) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) {
      throw new Error(`applyFixes only supports top-level fields, got "${field}"`);
    }
    const line = `${field}: ${stringify(value).trimEnd()}`;
    const existing = new RegExp(`^${field}:.*$`, "m");
    yaml = existing.test(yaml) ? yaml.replace(existing, line) : `${yaml}${line}\n`;
  }
  return `${open}${yaml}${rest}`;
}
