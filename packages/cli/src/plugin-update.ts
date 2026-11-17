import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { logEvent, VERSION } from "@homeostat/core";
import type { Io } from "./cli.ts";
import { claudeBinary, installedPlugin, PLUGIN_ID, recordPlugin } from "./plugin-info.ts";

/**
 * `homeostat plugin-update`: updates the homeostat Claude Code plugin, and only it, with Claude
 * Code's own `claude plugin update`. Session start runs it in the background when the plugin is
 * older than the CLI the KB pins; the new plugin applies from the next session.
 */
export async function runPluginUpdate(opts: { dir?: string }, io: Io): Promise<number> {
  const env = io.env ?? {};
  const before = installedPlugin(env)?.version;
  const result = await io.spawn?.(claudeBinary(env), ["plugin", "update", PLUGIN_ID], {
    timeoutMs: 120_000,
  });
  // After the update, Claude Code's install record, not the plugin this process runs from: that
  // one is the old copy until the next session.
  const installed = { ...env, CLAUDE_PLUGIN_ROOT: undefined };
  const after = installedPlugin(installed)?.version;
  const ok = result?.code === 0;
  const root = resolve(opts.dir ?? env.HOMEOSTAT_DIR ?? ".");
  if (existsSync(join(root, "homeostat.yaml"))) {
    recordPlugin(root, installed);
    logEvent(root, {
      ts: (io.now?.() ?? new Date()).toISOString(),
      type: "plugin-update",
      ok,
      cli: VERSION,
      ...(before ? { from: before } : {}),
      ...(after ? { to: after } : {}),
      ...(ok ? {} : { error: `${result?.stderr ?? ""}${result?.stdout ?? ""}`.trim().slice(-300) }),
    });
  }
  io.stdout(ok ? `homeostat plugin: ${before ?? "?"} -> ${after ?? "?"}\n` : "");
  if (!ok)
    io.stderr(
      `homeostat: the plugin update failed: ${(result?.stderr ?? "").trim().slice(-300)}\n`,
    );
  return ok ? 0 : 1;
}
