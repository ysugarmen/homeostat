#!/usr/bin/env node
// Runs `kbx hook <event>` with the hook's stdin, using the first kbx that exists:
// $KBX_CLI (path to a kbx bin script, for development), `kbx` on the PATH, then npx.
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
  ...(process.env.KBX_CLI ? [[process.execPath, [process.env.KBX_CLI, "hook", event]]] : []),
  ["kbx", ["hook", event]],
  ["npx", ["--yes", "kbx@0", "hook", event]],
];
for (const [command, args] of candidates) {
  if ((await run(command, args, input)) !== "missing") break;
}
process.exitCode = 0;
