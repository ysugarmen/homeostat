#!/usr/bin/env node
// Node strips types from .ts files in a checkout but not inside node_modules, so an installed
// package runs the compiled dist/ and the repo runs the source directly.
const { runCli } = import.meta.url.includes("/node_modules/")
  ? await import("../dist/src/cli.js")
  : await import("../src/cli.ts");

// A closed pipe (`homeostat validate | head`) means the reader has what it wanted, not a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

process.exitCode = await runCli(process.argv);
