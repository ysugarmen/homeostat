import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  codeownersFile,
  generateCodeowners,
  readKbFiles,
  validate,
  writeKbFile,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";
import { git } from "./git.ts";
import { detectHost } from "./init.ts";

/** `homeostat codeowners [dir]`: writes CODEOWNERS where the git host reads it, or with `--check` only reports whether it is stale. */
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

  const remote = git(root, "remote", "get-url", "origin");
  const file = codeownersFile(
    result.config.sources?.host ?? (remote ? detectHost(remote) : undefined),
  );
  const path = join(root, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (opts.check) {
    const fresh = current === text;
    io.stdout(
      fresh ? `${file} is up to date\n` : `${file} is out of date; run homeostat codeowners\n`,
    );
    return fresh ? 0 : 1;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeKbFile(root, file, text);
  io.stdout(`wrote ${file}\n`);
  return 0;
}
