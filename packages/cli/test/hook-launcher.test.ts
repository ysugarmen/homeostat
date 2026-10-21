import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const repo = new URL("../../../", import.meta.url).pathname;
const launcher = join(repo, "packages/plugin/hooks/run.mjs");

// The full path the plugin uses: plain Node runs the launcher, which runs the real homeostat bin.
test("the plugin's hook launcher runs homeostat and passes the event JSON through", () => {
  const kb = mkdtempSync(join(tmpdir(), "homeostat-launch-"));
  cpSync(join(repo, "examples/starter-kb"), kb, { recursive: true });
  const out = execFileSync(process.execPath, [launcher, "session-start"], {
    input: JSON.stringify({ session_id: "l1", cwd: kb, source: "startup" }),
    env: {
      ...process.env,
      HOMEOSTAT_CLI: join(repo, "packages/cli/bin/homeostat.js"),
      HOMEOSTAT_DIR: kb,
    },
    encoding: "utf8",
  });
  const context = JSON.parse(out).hookSpecificOutput.additionalContext;
  expect(context).toContain("(redact-before-logging)");
});

test("the launcher exits 0 even when homeostat fails", () => {
  const out = execFileSync(process.execPath, [launcher, "no-such-event"], {
    input: "{}",
    env: { ...process.env, HOMEOSTAT_CLI: join(repo, "packages/cli/bin/homeostat.js") },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  expect(out).toBe("");
});

// Without HOMEOSTAT_CLI the launcher uses a `homeostat` on the PATH only when it is the plugin's
// own version; anything else falls through to npx with the pinned version. Each scenario gets its
// own bin dir, since the version answer is cached per binary path and modification time.
describe("the launcher and a homeostat on the PATH", () => {
  const { version } = JSON.parse(
    readFileSync(join(repo, "packages/plugin/.claude-plugin/plugin.json"), "utf8"),
  ) as { version: string };
  const bins: string[] = [];
  afterAll(() => {
    for (const bin of bins) {
      const key = createHash("sha256").update(join(bin, "homeostat")).digest("hex").slice(0, 16);
      rmSync(join(tmpdir(), `homeostat-plugin-${key}.json`), { force: true });
    }
  });

  /** A bin dir with a fake `homeostat` (answering `--version` as told) and a fake `npx`. */
  function fakeBin(onVersion: string) {
    const bin = mkdtempSync(join(tmpdir(), "homeostat-launch-bin-"));
    bins.push(bin);
    const marker = join(bin, "homeostat.calls");
    writeFileSync(
      join(bin, "homeostat"),
      `#!/bin/sh\necho "$@" >> "${marker}"\nif [ "$1" = "--version" ]; then ${onVersion}; exit 0; fi\ncat > /dev/null\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "npx"),
      `#!/bin/sh\necho "$@" > "${join(bin, "npx.calls")}"\ncat > /dev/null\n`,
      { mode: 0o755 },
    );
    return { bin, marker, npx: join(bin, "npx.calls") };
  }

  function launch(bin: string) {
    execFileSync(process.execPath, [launcher, "session-start"], {
      input: "{}",
      env: { PATH: `${bin}${delimiter}${dirname(process.execPath)}`, HOME: process.env.HOME ?? "" },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  test("a matching version on the PATH runs the hook", () => {
    const f = fakeBin(`echo ${version}`);
    launch(f.bin);
    expect(readFileSync(f.marker, "utf8")).toBe(`--version\nhook session-start\n`);
    expect(existsSync(f.npx)).toBe(false);
  });

  test("an older version is skipped for npx with the pinned version", () => {
    const f = fakeBin("echo 0.1.7");
    launch(f.bin);
    expect(readFileSync(f.marker, "utf8")).toBe("--version\n");
    expect(readFileSync(f.npx, "utf8")).toBe(`--yes homeostat@${version} hook session-start\n`);
  });

  test("a binary that hangs on --version is skipped too", { timeout: 15_000 }, () => {
    const f = fakeBin("sleep 5");
    launch(f.bin);
    expect(readFileSync(f.npx, "utf8")).toContain(`homeostat@${version}`);
  });

  test("the version answer is cached, so the probe runs once a day", () => {
    const f = fakeBin(`echo ${version}`);
    launch(f.bin);
    launch(f.bin);
    const calls = readFileSync(f.marker, "utf8").split("\n");
    expect(calls.filter((c) => c === "--version")).toHaveLength(1);
    expect(calls.filter((c) => c === "hook session-start")).toHaveLength(2);
  });
});
