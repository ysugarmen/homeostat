#!/usr/bin/env node
// Runs `homeostat hook <event>` (or `homeostat mcp`) with the first homeostat that fits, in order:
// $HOMEOSTAT_CLI (a homeostat bin script, for development); a `homeostat` on the PATH, only when
// it prints the plugin's own version; else npx with that version. An older binary on the PATH
// would reject a newer KB and leave every session without rules, silently, so the PATH binary is
// checked, once a day per binary, and skipped on any answer but an exact match.
// Hooks get their stdin buffered and must never break a session, so they always exit 0.
// The MCP server is long-lived and talks over stdio, so it gets stdio passed straight through.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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

/** The first `homeostat` on the PATH, if any. */
function onPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, "homeostat");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

/**
 * Whether `bin` prints exactly the plugin's version. The answer is cached for a day per binary
 * path and modification time, so the probe costs a session start once a day, not every time.
 */
function matchesVersion(bin) {
  let mtimeMs;
  try {
    mtimeMs = statSync(bin).mtimeMs;
  } catch {
    return false;
  }
  const key = createHash("sha256").update(bin).digest("hex").slice(0, 16);
  const cache = join(tmpdir(), `homeostat-plugin-${key}.json`);
  try {
    const c = JSON.parse(readFileSync(cache, "utf8"));
    if (c.mtimeMs === mtimeMs && c.version === version && Date.now() - c.checkedAt < 86_400_000)
      return c.matches === true;
  } catch {
    // No cache yet, or an unreadable one: probe.
  }
  const probe = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const matches = !probe.error && probe.status === 0 && probe.stdout.trim() === version;
  try {
    writeFileSync(cache, JSON.stringify({ mtimeMs, version, checkedAt: Date.now(), matches }));
  } catch {
    // A read-only temp dir only costs the probe again next time.
  }
  return matches;
}

const input = isMcp ? undefined : await readStdin();
// Each candidate is worked out only when the ones before it were missing, so a development
// checkout never probes the PATH.
const candidates = [
  ...(process.env.HOMEOSTAT_CLI
    ? [() => [process.execPath, [process.env.HOMEOSTAT_CLI, ...cliArgs]]]
    : []),
  () => {
    const bin = onPath();
    return bin && matchesVersion(bin) ? [bin, cliArgs] : undefined;
  },
  () => ["npx", ["--yes", `homeostat@${version}`, ...cliArgs]],
];
let result = { outcome: "missing" };
for (const candidate of candidates) {
  const c = candidate();
  if (!c) continue;
  result = await run(c[0], c[1], input);
  if (result.outcome !== "missing") break;
}
process.exitCode = isMcp ? (result.code ?? 1) : 0;
