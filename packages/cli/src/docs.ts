import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  areaMap,
  CORE_AREA,
  convertDoc,
  docFilePath,
  readKbFiles,
  slugify,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { formatIssues } from "./format.ts";
import { resolveRepo } from "./repo-option.ts";

export interface ConvertDocsOptions {
  dir?: string;
  area: string;
  owner: string;
  scope?: string[];
  force?: boolean;
  /** A multi-repo KB: the repo the documents describe; --shared for knowledge/core/docs/. */
  repo?: string;
  shared?: boolean;
}

/**
 * `homeostat docs convert <file...>`: brings existing markdown documents into the KB as
 * `knowledge/<area>/docs/<topic>.md`, then validates them so real defects are listed.
 */
export function runConvertDocs(files: string[], opts: ConvertDocsOptions, io: Io): number {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const { config } = validate(readKbFiles(root));
  if (!config) {
    io.stderr("homeostat.yaml is missing or invalid; run homeostat validate\n");
    return 1;
  }
  let repo: string | undefined;
  try {
    repo = resolveRepo(config, opts);
  } catch (e) {
    io.stderr(`${(e as Error).message}\n`);
    return 1;
  }
  const areas = areaMap(config, repo);
  if ((opts.area !== CORE_AREA && !areas[opts.area]) || (opts.shared && opts.area !== CORE_AREA)) {
    io.stderr(
      `unknown area "${opts.area}"${repo ? ` in repo ${repo}` : ""}; use one of: ${opts.shared ? CORE_AREA : [CORE_AREA, ...Object.keys(areas)].join(", ")}\n`,
    );
    return 1;
  }
  const scope = opts.scope?.length ? opts.scope : [...(areas[opts.area] ?? ["**"])];
  const today = (io.now?.() ?? new Date()).toISOString().slice(0, 10);
  const written: string[] = [];
  for (const file of files) {
    const name = slugify(basename(file).replace(/\.md$/i, "")) ?? "document";
    const path = docFilePath(config, { repo, area: opts.area, topic: name });
    const target = join(root, ...path.split("/"));
    if (existsSync(target) && !opts.force) {
      io.stderr(`${path} already exists; use --force to overwrite\n`);
      return 1;
    }
    const { text, notes } = convertDoc(readFileSync(file, "utf8"), {
      area: opts.area,
      owner: opts.owner,
      scope,
      today,
      fallbackTitle: name.replace(/-/g, " "),
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(path);
    io.stdout(`wrote ${path}${notes.length ? `\n  ${notes.join("\n  ")}` : ""}\n`);
  }
  const result = validate(readKbFiles(root));
  const issues = result.issues.filter((i) => i.file && written.includes(i.file));
  if (issues.length) io.stdout(`\n${formatIssues(issues, io).text}`);
  else io.stdout(`\nall ${written.length} documents validate\n`);
  return issues.some((i) => i.severity === "error") ? 1 : 0;
}
