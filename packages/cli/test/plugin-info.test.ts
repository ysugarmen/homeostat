import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents, VERSION } from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { type Io, runCli } from "../src/cli.ts";
import {
  installedPlugin,
  olderVersion,
  recordedPlugin,
  recordPlugin,
  selfUpdateAllowed,
  selfUpdateDue,
} from "../src/plugin-info.ts";

function plugin(version: string, hooks: string[]) {
  const root = mkdtempSync(join(tmpdir(), "homeostat-plugin-"));
  mkdirSync(join(root, ".claude-plugin"));
  mkdirSync(join(root, "hooks"));
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "homeostat", version }),
  );
  writeFileSync(
    join(root, "hooks", "hooks.json"),
    JSON.stringify({ hooks: Object.fromEntries(hooks.map((h) => [h, []])) }),
  );
  return root;
}

describe("the installed plugin, for heartbeats", () => {
  test("read from the running hook's plugin, or from Claude Code's install record", () => {
    const own = plugin("0.5.20", ["SessionStart", "PostToolUse", "PreToolUse"]);
    expect(installedPlugin({ CLAUDE_PLUGIN_ROOT: own })).toEqual({
      version: "0.5.20",
      hooks: ["SessionStart", "PostToolUse", "PreToolUse"],
    });
    // An older launcher may not pass where it is: Claude Code's own record says.
    const old = plugin("0.5.11", ["SessionStart", "UserPromptSubmit"]);
    const config = mkdtempSync(join(tmpdir(), "homeostat-claude-"));
    mkdirSync(join(config, "plugins"));
    writeFileSync(
      join(config, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "homeostat@homeostat": [{ installPath: old, version: "0.5.11" }] },
      }),
    );
    expect(installedPlugin({ CLAUDE_CONFIG_DIR: config })?.version).toBe("0.5.11");
    expect(installedPlugin({ CLAUDE_CONFIG_DIR: join(config, "missing") })).toBeUndefined();
  });

  test("recorded in the clone at session start, read back by the next sync", () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-kb-"));
    expect(recordedPlugin(kb)).toBeUndefined();
    recordPlugin(kb, { CLAUDE_PLUGIN_ROOT: plugin("0.5.20", ["SessionStart"]) });
    expect(recordedPlugin(kb)).toEqual({ version: "0.5.20", hooks: ["SessionStart"] });
  });
});

/** A Claude Code config dir with the given settings files. */
function claudeConfig(files: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "homeostat-claude-"));
  mkdirSync(join(dir, "plugins"));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
}
const marketplace = (autoUpdate: boolean) => ({
  extraKnownMarketplaces: {
    homeostat: { source: { source: "github", repo: "acme/homeostat" }, autoUpdate },
  },
});

describe("the plugin updates itself, only where its marketplace may", () => {
  test("allowed by the organization's setting, the developer's, or what Claude Code recorded", () => {
    expect(selfUpdateAllowed({ CLAUDE_CONFIG_DIR: claudeConfig({}) })).toBe(false);
    expect(
      selfUpdateAllowed({
        CLAUDE_CONFIG_DIR: claudeConfig({ "remote-settings.json": marketplace(true) }),
      }),
    ).toBe(true);
    // The organization's setting wins over the developer's.
    expect(
      selfUpdateAllowed({
        CLAUDE_CONFIG_DIR: claudeConfig({
          "remote-settings.json": marketplace(false),
          "settings.json": marketplace(true),
        }),
      }),
    ).toBe(false);
    expect(
      selfUpdateAllowed({
        CLAUDE_CONFIG_DIR: claudeConfig({
          "plugins/known_marketplaces.json": { homeostat: { autoUpdate: true } },
        }),
      }),
    ).toBe(true);
  });

  test("due when older than the pinned CLI, at most once per version every 12 hours", () => {
    expect(olderVersion("0.5.11", "0.5.21")).toBe(true);
    expect(olderVersion("0.5.21", "0.5.21")).toBe(false);
    expect(olderVersion("0.6.0", "0.5.21")).toBe(false);
    const kb = mkdtempSync(join(tmpdir(), "homeostat-kb-"));
    const env = { CLAUDE_CONFIG_DIR: claudeConfig({ "remote-settings.json": marketplace(true) }) };
    const old = { version: "0.5.11", hooks: ["SessionStart"] };
    const t0 = new Date("2026-11-17T09:00:00Z");
    expect(selfUpdateDue(kb, old, "0.5.21", env, t0)).toBe(true);
    // The next session start, an hour later: the update is already on its way.
    expect(selfUpdateDue(kb, old, "0.5.21", env, new Date("2026-11-17T10:00:00Z"))).toBe(false);
    expect(selfUpdateDue(kb, old, "0.5.21", env, new Date("2026-11-17T21:30:00Z"))).toBe(true);
    // Current, or not allowed: never.
    expect(selfUpdateDue(kb, { ...old, version: "0.5.21" }, "0.5.21", env, t0)).toBe(false);
    expect(selfUpdateDue(kb, old, "0.5.30", { CLAUDE_CONFIG_DIR: claudeConfig({}) }, t0)).toBe(
      false,
    );
  });
});

describe("session start and homeostat plugin-update", () => {
  const starter = new URL("../../../examples/starter-kb/", import.meta.url).pathname;
  const kbCopy = () => {
    const kb = mkdtempSync(join(tmpdir(), "homeostat-kb-"));
    cpSync(starter, kb, { recursive: true });
    return kb;
  };
  const io = (env: Record<string, string>, extra: Partial<Io> = {}) => {
    const background: string[][] = [];
    let stdout = "";
    const value: Io = {
      stdout: (t) => (stdout += t),
      stderr: () => {},
      color: false,
      env,
      stdin: async () =>
        JSON.stringify({ session_id: "p1", cwd: env.HOMEOSTAT_DIR, source: "startup" }),
      background: (args) => background.push(args),
      now: () => new Date("2026-11-17T09:00:00Z"),
      ...extra,
    };
    return { value, background, out: () => stdout };
  };

  test("an older plugin whose marketplace may auto-update starts its own update in the background", async () => {
    const kb = kbCopy();
    const root = plugin("0.0.1", ["SessionStart"]);
    const allowed = claudeConfig({ "remote-settings.json": marketplace(true) });
    const run = io({ HOMEOSTAT_DIR: kb, CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: allowed });
    await runCli(["node", "homeostat", "hook", "session-start"], run.value);
    expect(run.background).toContainEqual(["plugin-update", "--dir", kb]);
    // Not allowed: nothing, however old.
    const blocked = io({
      HOMEOSTAT_DIR: kbCopy(),
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_CONFIG_DIR: claudeConfig({}),
    });
    await runCli(["node", "homeostat", "hook", "session-start"], blocked.value);
    expect(blocked.background.some((a) => a[0] === "plugin-update")).toBe(false);
    // Current: nothing.
    const current = io({
      HOMEOSTAT_DIR: kbCopy(),
      CLAUDE_PLUGIN_ROOT: plugin(VERSION, ["SessionStart"]),
      CLAUDE_CONFIG_DIR: allowed,
    });
    await runCli(["node", "homeostat", "hook", "session-start"], current.value);
    expect(current.background.some((a) => a[0] === "plugin-update")).toBe(false);
  });

  test("plugin-update runs Claude Code's update for this plugin only, and logs the result", async () => {
    const kb = kbCopy();
    const calls: string[][] = [];
    const run = io(
      {
        HOMEOSTAT_DIR: kb,
        CLAUDE_PLUGIN_ROOT: plugin("0.5.11", ["SessionStart"]),
        CLAUDE_CODE_EXECPATH: "",
      },
      {
        spawn: async (command, args) => {
          calls.push([command, ...args]);
          return { code: 0, stdout: "updated", stderr: "" };
        },
      },
    );
    expect(await runCli(["node", "homeostat", "plugin-update", "--dir", kb], run.value)).toBe(0);
    expect(calls).toEqual([["claude", "plugin", "update", "homeostat@homeostat"]]);
    const event = readEvents(kb, { since: "2026-01-01" }).find((e) => e.type === "plugin-update");
    expect(event).toMatchObject({ ok: true, from: "0.5.11" });
    // No install record in this test's environment: "to" is left out rather than the old copy.
    expect(event?.to).toBeUndefined();
  });
});
