#!/usr/bin/env node
// Runs `homeostat hook <event>` with the hook's stdin, using the first homeostat that exists:
// $HOMEOSTAT_CLI (path to a homeostat bin script, for development), `homeostat` on the PATH, then npx.
// A hook must never break a session, so this always exits 0.
import { spawn } from "node:child_process";

const event = process.argv[2] ?? "";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function run(command, args, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", (error) => resolve(error.code === "ENOENT" ? "missing" : "failed"));
    child.on("close", () => resolve("ran"));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const input = await readStdin();
const candidates = [
  ...(process.env.HOMEOSTAT_CLI
    ? [[process.execPath, [process.env.HOMEOSTAT_CLI, "hook", event]]]
    : []),
  ["homeostat", ["hook", event]],
  ["npx", ["--yes", "homeostat@0", "hook", event]],
];
for (const [command, args] of candidates) {
  if ((await run(command, args, input)) !== "missing") break;
}
process.exitCode = 0;
