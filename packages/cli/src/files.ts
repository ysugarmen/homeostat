import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { CONFIG_FILE, type KbFiles } from "@homeostat/core";

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
