import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CODEOWNERS_FILE,
  generateCodeowners,
  readKbFiles,
  validate,
  writeKbFile,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";

/** `homeostat codeowners [dir]`: writes CODEOWNERS, or with `--check` only reports whether it is stale. */
export function runCodeowners(dir: string, opts: { check?: boolean }, io: Io): number {
  const root = resolve(dir);
  const result = validate(readKbFiles(root));
  if (!result.ok || !result.config) {
    const errors = result.issues.filter((i) => i.severity === "error");
    io.stdout(
      `${formatIssues(errors, io).text}fix the errors above before generating CODEOWNERS\n`,
    );
    return 1;
  }

  const { text, issues } = generateCodeowners(
    result.config,
    result.entries.map((e) => e.entry.frontmatter),
  );
  if (issues.length > 0) {
    io.stdout(formatIssues(issues, io).text);
    return 1;
  }

  const path = join(root, CODEOWNERS_FILE);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (opts.check) {
    const fresh = current === text;
    io.stdout(
      fresh
        ? `${CODEOWNERS_FILE} is up to date\n`
        : `${CODEOWNERS_FILE} is out of date; run homeostat codeowners\n`,
    );
    return fresh ? 0 : 1;
  }

  writeKbFile(root, CODEOWNERS_FILE, text);
  io.stdout(`wrote ${CODEOWNERS_FILE}\n`);
  return 0;
}
