#!/usr/bin/env node
// Runs `homeostat hook <event>` (or `homeostat mcp`) using the first homeostat that exists:
// $HOMEOSTAT_CLI (path to a homeostat bin script, for development), `homeostat` on the PATH, then npx
// with the plugin's own version.
// Hooks get their stdin buffered and must never break a session, so they always exit 0.
// The MCP server is long-lived and talks over stdio, so it gets stdio passed straight through.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// The npx fallback runs exactly the CLI version this plugin was released with, never a floating
// range: a compromised later release must not reach every session (security plan T4).
const { version } = JSON.parse(
  readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"),
);

const mode = process.argv[2] ?? "";
const isMcp = mode === "mcp";
const cliArgs = isMcp ? ["mcp"] : ["hook", mode];

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function run(command, args, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [isMcp ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.on("error", (error) =>
      resolve({ outcome: error.code === "ENOENT" ? "missing" : "failed" }),
    );
    child.on("close", (code) => resolve({ outcome: "ran", code }));
    if (!isMcp) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

const input = isMcp ? undefined : await readStdin();
const candidates = [
  ...(process.env.HOMEOSTAT_CLI
    ? [[process.execPath, [process.env.HOMEOSTAT_CLI, ...cliArgs]]]
    : []),
  ["homeostat", cliArgs],
  ["npx", ["--yes", `homeostat@${version}`, ...cliArgs]],
];
let result = { outcome: "missing" };
for (const [command, args] of candidates) {
  result = await run(command, args, input);
  if (result.outcome !== "missing") break;
}
process.exitCode = isMcp ? (result.code ?? 1) : 0;
