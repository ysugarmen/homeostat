#!/usr/bin/env node
import { runCli } from "../src/cli.ts";

// A closed pipe (`homeostat validate | head`) means the reader has what it wanted, not a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

process.exitCode = await runCli(process.argv);
