import { resolve } from "node:path";
import {
  applyFixes,
  type Fix,
  readKbFiles,
  type ValidateResult,
  validate,
  writeKbFile,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { formatIssues, painter, plural } from "./format.ts";

export interface ValidateOptions {
  fix?: boolean;
  json?: boolean;
}

/** `homeostat validate [dir]`. Returns the process exit code: 1 when there are errors. */
export function runValidate(dir: string, opts: ValidateOptions, io: Io): number {
  const root = resolve(dir);
  let files = readKbFiles(root);
  let result = validate(files);

  if (opts.fix) {
    const byFile = new Map<string, Fix[]>();
    for (const issue of result.issues) {
      if (issue.fix && issue.file) {
        byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), issue.fix]);
      }
    }
    let fields = 0;
    for (const [path, fixes] of byFile) {
      writeKbFile(root, path, applyFixes(files[path] ?? "", fixes));
      fields += fixes.length;
    }
    if (byFile.size > 0 && !opts.json) {
      io.stdout(`fixed ${plural(fields, "field")} in ${plural(byFile.size, "file")}\n`);
      files = readKbFiles(root);
      result = validate(files);
    }
  }

  io.stdout(opts.json ? `${JSON.stringify(toJson(result), null, 2)}\n` : format(result, io));
  return result.ok ? 0 : 1;
}

function toJson(result: ValidateResult) {
  return { ok: result.ok, entries: result.entries.length, issues: result.issues };
}

function format(result: ValidateResult, io: Io): string {
  const entries = plural(result.entries.length, "entry", "entries");
  if (result.issues.length === 0) return `${painter(io)("green", "✓")} ${entries}, no problems\n`;

  const { text, files } = formatIssues(result.issues, io);
  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warnings = result.issues.length - errors;
  const fixable = result.issues.filter((i) => i.fix).length;
  let out = `${text}${plural(errors, "error")}, ${plural(warnings, "warning")} in ${plural(files, "file")} (${entries} parsed)`;
  if (fixable > 0) out += `; ${fixable} fixable; run homeostat validate --fix`;
  return `${out}\n`;
}
