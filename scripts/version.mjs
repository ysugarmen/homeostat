#!/usr/bin/env node
// Sets one version everywhere a release pins it: every package.json, the plugin manifest,
// core's VERSION constant (which `init` writes into CI files), and each `homeostat@x.y.z`
// in the skills and docs. Usage: node scripts/version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/version.mjs <semver>");
  process.exit(1);
}
const root = new URL("../", import.meta.url);
const edit = (path, fn) => {
  const url = new URL(path, root);
  const before = readFileSync(url, "utf8");
  const after = fn(before);
  if (after !== before) {
    writeFileSync(url, after);
    console.log(`updated ${path}`);
  }
};

for (const pkg of ["cli", "core", "mcp", "dashboard", "plugin"]) {
  const path =
    pkg === "plugin"
      ? "packages/plugin/.claude-plugin/plugin.json"
      : `packages/${pkg}/package.json`;
  edit(path, (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
edit("packages/core/src/version.ts", (s) =>
  s.replace(/VERSION = "[^"]+"/, `VERSION = "${version}"`),
);
export const PINNED_FILES = [
  "README.md",
  "packages/plugin/README.md",
  "packages/plugin/skills/learn/SKILL.md",
  "packages/plugin/skills/review/SKILL.md",
  "packages/plugin/skills/explain/SKILL.md",
  "packages/mcp/README.md",
  "docs/demo.md",
];
for (const path of PINNED_FILES) {
  edit(path, (s) => s.replace(/homeostat@\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?/g, `homeostat@${version}`));
}
