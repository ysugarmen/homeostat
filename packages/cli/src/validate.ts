import { resolve } from "node:path";
import { styleText } from "node:util";
import { applyFixes, type Fix, type Issue, type ValidateResult, validate } from "@kbx/core";
import type { Io } from "./cli.ts";
import { readKbFiles, writeKbFile } from "./files.ts";

export interface ValidateOptions {
  fix?: boolean;
  json?: boolean;
}

/** `kbx validate [dir]`. Returns the process exit code: 1 when there are errors. */
export function runValidate(dir: string, opts: ValidateOptions, io: Io): number {
  const root = resolve(dir);
  let files = readKbFiles(root);
  let result = validate(files);

  if (opts.fix) {
    const byFile = new Map<string, Fix[]>();
    for (const issue of result.issues) {
      if (issue.fix && issue.file)
        byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), issue.fix]);
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
  const paint = (style: Parameters<typeof styleText>[0], text: string) =>
    io.color ? styleText(style, text) : text;
  const entries = result.entries.length;
  if (result.issues.length === 0) {
    return `${paint("green", "✓")} ${plural(entries, "entry", "entries")}, no problems\n`;
  }

  const byFile = new Map<string, Issue[]>();
  for (const issue of result.issues) {
    const file = issue.file ?? "(knowledge base)";
    byFile.set(file, [...(byFile.get(file) ?? []), issue]);
  }

  let out = "";
  for (const [file, issues] of byFile) {
    out += `${paint("underline", file)}\n`;
    for (const i of issues) {
      const label = i.severity === "error" ? paint("red", "error") : paint("yellow", "warning");
      out += `  ${label}  ${i.message}  ${paint("dim", i.code)}\n`;
    }
    out += "\n";
  }

  const errors = result.issues.filter((i) => i.severity === "error").length;
  const warnings = result.issues.length - errors;
  const fixable = result.issues.filter((i) => i.fix).length;
  out += `${plural(errors, "error")}, ${plural(warnings, "warning")} in ${plural(byFile.size, "file")} (${plural(entries, "entry", "entries")} parsed)`;
  if (fixable > 0) out += `; ${fixable} fixable; run kbx validate --fix`;
  return `${out}\n`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
