import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
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

const MARKETPLACE = "homeostat";
const PLUGIN = "homeostat@homeostat";

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/** Claude Code's managed settings file for this machine (set by an admin or MDM). */
function managedSettingsPath(): string {
  if (platform() === "darwin")
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform() === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Whether the homeostat marketplace may update itself here: `autoUpdate` on its
 * `extraKnownMarketplaces` entry in managed settings (an admin's, from a file or the
 * organization's console), then the developer's own settings, then what Claude Code recorded
 * for the marketplace. Off unless someone turned it on: that is the permission this uses.
 */
export function selfUpdateAllowed(env: Record<string, string | undefined>): boolean {
  const config = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const fromSettings = (path: string) => {
    const s = readJson(path) as
      | { extraKnownMarketplaces?: Record<string, { autoUpdate?: unknown }> }
      | undefined;
    const v = s?.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate;
    return typeof v === "boolean" ? v : undefined;
  };
  for (const path of [
    managedSettingsPath(),
    join(config, "remote-settings.json"),
    join(config, "settings.json"),
  ]) {
    const v = fromSettings(path);
    if (v !== undefined) return v;
  }
  const known = readJson(join(config, "plugins", "known_marketplaces.json")) as
    | Record<string, { autoUpdate?: unknown }>
    | undefined;
  return known?.[MARKETPLACE]?.autoUpdate === true;
}

/** Whether version `a` is older than `b` (x.y.z). */
export function olderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

const ATTEMPT = ".homeostat/plugin-update.json";
/** A failed or pending update is tried again after this long, never on every session start. */
const RETRY_MS = 12 * 3_600_000;

/**
 * Whether to update the plugin now: it is older than the CLI the KB pins, its marketplace may
 * update itself, and this version was not tried in the last 12 hours. Records the try.
 */
export function selfUpdateDue(
  kbRoot: string,
  installed: PluginInfo,
  wanted: string,
  env: Record<string, string | undefined>,
  now: Date,
): boolean {
  if (!olderVersion(installed.version, wanted) || !selfUpdateAllowed(env)) return false;
  const last = readJson(join(kbRoot, ATTEMPT)) as { target?: string; at?: string } | undefined;
  if (last?.target === wanted && last.at && now.getTime() - Date.parse(last.at) < RETRY_MS)
    return false;
  try {
    mkdirSync(join(kbRoot, ".homeostat"), { recursive: true });
    writeFileSync(
      join(kbRoot, ATTEMPT),
      `${JSON.stringify({ target: wanted, at: now.toISOString() })}\n`,
    );
  } catch {
    return false;
  }
  return true;
}

/** The Claude Code binary: the one running this session when it says so, else `claude`. */
export function claudeBinary(env: Record<string, string | undefined>): string {
  const exec = env.CLAUDE_CODE_EXECPATH;
  return exec && existsSync(exec) ? exec : "claude";
}

export const PLUGIN_ID = PLUGIN;
