#!/usr/bin/env node
// Builds the desktop app (unsigned macOS .dmg, arm64 and x64) into packages/desktop/release/.
//
// The workspace packages run from TypeScript source in development, and Node does not strip types
// under node_modules, so the app ships their built dist instead: the script stages the desktop
// package with flat production dependencies, switches each workspace package to its publishConfig
// entry points (as publishing does), checks the staged app loads, then runs electron-builder.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const desktop = join(root, "packages/desktop");
const stage = join(desktop, "stage");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("pnpm", ["run", "typecheck"]); // tsc -b writes every package's dist
rmSync(stage, { recursive: true, force: true });
run("pnpm", [
  "--filter",
  "@homeostat/desktop",
  "deploy",
  "--prod",
  "--legacy",
  "--config.node-linker=hoisted",
  stage,
]);

for (const name of readdirSync(join(stage, "node_modules/@homeostat"))) {
  const file = join(stage, "node_modules/@homeostat", name, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const { publishConfig = {} } = pkg;
  for (const key of ["exports", "main", "types", "bin"])
    if (key in publishConfig) pkg[key] = publishConfig[key];
  delete pkg.publishConfig;
  // pnpm deploy hard-links files into the stage: replace the file, never write through the link,
  // or the workspace package's own package.json changes too.
  rmSync(file);
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
// The staged app must load with plain Node before it is packaged, and the workspace is untouched.
run("git", [
  "diff",
  "--exit-code",
  "--",
  "packages/core/package.json",
  "packages/dashboard/package.json",
]);
run(
  "node",
  ["-e", "await import('@homeostat/dashboard'); await import('@homeostat/core');"],
  stage,
);

const electron = JSON.parse(
  readFileSync(join(desktop, "node_modules/electron/package.json"), "utf8"),
).version;
run(
  join(desktop, "node_modules/.bin/electron-builder"),
  [
    "--mac",
    "--projectDir",
    stage,
    `-c.electronVersion=${electron}`,
    `-c.directories.output=${join(desktop, "release")}`,
  ],
  stage,
);
rmSync(stage, { recursive: true, force: true });
