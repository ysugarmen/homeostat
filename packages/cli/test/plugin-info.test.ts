import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installedPlugin, recordedPlugin, recordPlugin } from "../src/plugin-info.ts";

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
