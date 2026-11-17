import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The installed Claude Code plugin, as a session start sees it. */
export interface PluginInfo {
  version: string;
  hooks: string[];
}

const RECORD = ".homeostat/plugin.json";

/**
 * The homeostat plugin Claude Code has installed: the running hook's own plugin when Claude Code
 * says where it is, else the one its install record names. Read from disk, so it works whatever
 * plugin version launched this CLI.
 */
export function installedPlugin(env: Record<string, string | undefined>): PluginInfo | undefined {
  const fromRoot = (root: string | undefined): PluginInfo | undefined => {
    if (!root) return undefined;
    try {
      const manifest = JSON.parse(
        readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
      );
      const hooks = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")).hooks ?? {};
      return typeof manifest.version === "string"
        ? { version: manifest.version, hooks: Object.keys(hooks) }
        : undefined;
    } catch {
      return undefined;
    }
  };
  const own =
    env.CLAUDE_PLUGIN_ROOT && !env.CLAUDE_PLUGIN_ROOT.includes("${")
      ? env.CLAUDE_PLUGIN_ROOT
      : undefined;
  const found = fromRoot(own);
  if (found) return found;
  try {
    const config = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const installed = JSON.parse(
      readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"),
    );
    const list = (installed.plugins ?? installed)["homeostat@homeostat"];
    return fromRoot(Array.isArray(list) ? list[0]?.installPath : undefined);
  } catch {
    return undefined;
  }
}

/** Notes the installed plugin in the KB clone, for the next heartbeat to report. */
export function recordPlugin(kbRoot: string, env: Record<string, string | undefined>) {
  const info = installedPlugin(env);
  if (!info) return;
  try {
    mkdirSync(join(kbRoot, ".homeostat"), { recursive: true });
    writeFileSync(join(kbRoot, RECORD), `${JSON.stringify(info)}\n`);
  } catch {
    // A read-only clone only loses the report.
  }
}

/** The plugin the last session start recorded, if any. */
export function recordedPlugin(kbRoot: string): PluginInfo | undefined {
  const path = join(kbRoot, RECORD);
  if (!existsSync(path)) return undefined;
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    return typeof info?.version === "string" && Array.isArray(info.hooks) ? info : undefined;
  } catch {
    return undefined;
  }
}
