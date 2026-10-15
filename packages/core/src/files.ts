import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { CONFIG_FILE } from "./config.ts";
import type { KbFiles } from "./validate.ts";

/** Reads the parts of a KB that `validate()` looks at: the config and everything under knowledge/. */
export function readKbFiles(root: string): KbFiles {
  const files: KbFiles = {};
  const configPath = join(root, CONFIG_FILE);
  if (existsSync(configPath)) files[CONFIG_FILE] = readFileSync(configPath, "utf8");

  const knowledge = join(root, "knowledge");
  if (existsSync(knowledge)) {
    for (const rel of readdirSync(knowledge, { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".md")) continue;
      files[`knowledge/${rel.split(sep).join("/")}`] = readFileSync(join(knowledge, rel), "utf8");
    }
  }
  return files;
}

export function writeKbFile(root: string, path: string, content: string) {
  writeFileSync(join(root, ...path.split("/")), content);
}

/**
 * A developer's own lessons, not yet decided by the daily run. They live in the KB clone but
 * outside git (`.homeostat/` is ignored), so the clone stays clean for its daily pull, and they
 * apply to that developer's sessions at once. Paths mirror the KB: `knowledge/<area>/<id>.md`.
 */
export const PENDING_DIR = ".homeostat/pending";

export function readPendingFiles(root: string): KbFiles {
  const files: KbFiles = {};
  const base = join(root, PENDING_DIR, "knowledge");
  if (!existsSync(base)) return files;
  for (const rel of readdirSync(base, { recursive: true, encoding: "utf8" })) {
    if (!rel.endsWith(".md")) continue;
    files[`knowledge/${rel.split(sep).join("/")}`] = readFileSync(join(base, rel), "utf8");
  }
  return files;
}

/**
 * The KB as one developer sees it: the committed files with their pending lessons on top. With
 * `inForce`, a pending candidate reads as accepted, so the developer's own sessions follow their
 * own lessons right away; the daily run still decides whether the team gets them.
 */
export function readKbView(
  root: string,
  opts: { inForce?: boolean } = {},
): { files: KbFiles; pending: Set<string> } {
  const pending = readPendingFiles(root);
  if (opts.inForce) {
    for (const [path, text] of Object.entries(pending)) {
      pending[path] = text.replace(/^status: candidate$/m, "status: accepted");
    }
  }
  return { files: { ...readKbFiles(root), ...pending }, pending: new Set(Object.keys(pending)) };
}

export function writePendingFile(root: string, path: string, content: string) {
  const full = join(root, PENDING_DIR, ...path.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function removePendingFile(root: string, path: string) {
  rmSync(join(root, PENDING_DIR, ...path.split("/")), { force: true });
}
