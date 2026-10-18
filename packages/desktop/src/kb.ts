import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CONFIG_FILE, readKbFiles, validate } from "@homeostat/core";
import type { RefreshResult } from "@homeostat/dashboard";

/** What the app remembers between launches, in its own data folder. */
export interface Prefs {
  kbDir?: string;
  /** Refresh every minute while the window is open (off by default). */
  live?: boolean;
}

export function readPrefs(file: string): Prefs {
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Prefs;
    return {
      ...(typeof p.kbDir === "string" ? { kbDir: p.kbDir } : {}),
      ...(p.live === true ? { live: true } : {}),
    };
  } catch {
    return {};
  }
}

export function writePrefs(file: string, prefs: Prefs): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
}

/**
 * An app opened from the Finder gets a bare PATH, without Homebrew's git; add the usual places
 * after whatever is already there.
 */
export function gitPath(env: Readonly<Record<string, string | undefined>>): string {
  const have = (env.PATH ?? "").split(":").filter(Boolean);
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...have, ...extra.filter((d) => !have.includes(d))].join(":");
}

export type KbCheck =
  | { ok: true; root: string; name: string; base: string }
  | { ok: false; error: string };

/** A folder the app can show: a git checkout with a valid homeostat.yaml. */
export function checkKb(dir: string): KbCheck {
  const root = resolve(dir);
  if (!existsSync(join(root, CONFIG_FILE)))
    return { ok: false, error: `${root} has no ${CONFIG_FILE}; choose your team's KB checkout` };
  if (!existsSync(join(root, ".git")))
    return { ok: false, error: `${root} is not a git checkout, so it cannot be kept current` };
  const config = validate(readKbFiles(root)).config;
  if (!config)
    return {
      ok: false,
      error: `${CONFIG_FILE} in ${root} is invalid; run homeostat validate there`,
    };
  return {
    ok: true,
    root,
    name: config.sources?.kbRepo ?? basename(root),
    base: config.sources?.baseBranch ?? "main",
  };
}

/**
 * Where a clone of `url` goes under `parent`, or why `url` is refused. Only https, ssh and
 * scp-style git URLs, so nothing typed into the box can reach git as an option.
 */
export function cloneTarget(url: string, parent: string): { dir: string } | { error: string } {
  const u = url.trim();
  if (!/^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(u))
    return { error: "use the repository's https or ssh clone URL" };
  const name = /([^/:]+?)(?:\.git)?\/?$/.exec(u)?.[1];
  if (!name || name.startsWith(".")) return { error: "could not tell the repository's name" };
  const dir = join(parent, name);
  if (existsSync(dir)) return { error: `${dir} already exists; open it instead` };
  return { dir };
}

const run = promisify(execFile);

/** Clones with the git credentials already on this machine; never prompts. */
export async function cloneKb(
  url: string,
  parent: string,
): Promise<{ dir: string } | { error: string }> {
  const target = cloneTarget(url, parent);
  if ("error" in target) return target;
  mkdirSync(parent, { recursive: true });
  try {
    await run("git", ["clone", "--quiet", "--", url.trim(), target.dir], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 300_000,
    });
    return target;
  } catch (e) {
    const detail = String((e as { stderr?: string }).stderr ?? (e as Error).message).trim();
    return { error: `git could not clone it: ${detail.split("\n").at(-1)}` };
  }
}

/** The window title says what is shown and how current it is. */
export function windowTitle(name: string, r: RefreshResult | undefined, at: Date): string {
  const time = at.toTimeString().slice(0, 5);
  if (!r) return `Homeostat · ${name}`;
  if (r.error) return `Homeostat · ${name} · offline, as of the last fetch`;
  if (r.behind)
    return `Homeostat · ${name} · ${r.behind} commit${r.behind === 1 ? "" : "s"} behind (${r.reason})`;
  return `Homeostat · ${name} · updated ${time}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The first-run page: open a KB checkout, or clone one. Self-contained, no network. */
export function setupPage(error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Homeostat</title><style>
:root{color-scheme:dark;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6e8ee}
main{width:min(460px,90vw)}h1{font-size:22px;margin:0 0 4px}p{color:#9aa3b2;margin:0 0 20px}
button{font:inherit;border:0;border-radius:10px;padding:10px 16px;background:linear-gradient(135deg,#8b5cf6,#3b82f6);color:#fff;cursor:pointer}
button.ghost{background:#1a1f2b}form{display:flex;gap:8px;margin-top:20px}
input{flex:1;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #2a3140;background:#121621;color:inherit}
.error{color:#f87171;margin-top:16px;min-height:1.5em}
</style></head><body><main>
<h1>Homeostat</h1>
<p>Open your team's knowledge base: the git checkout with homeostat.yaml. The app keeps it current from origin and never pushes.</p>
<button id="choose">Open KB folder…</button>
<form id="clone"><input id="url" placeholder="or paste its clone URL" aria-label="Clone URL" autocomplete="off"><button class="ghost">Clone</button></form>
<div class="error" role="alert" id="err">${error ? esc(error) : ""}</div>
<script>
const err = document.getElementById("err");
const busy = (b) => document.querySelectorAll("button").forEach((x) => (x.disabled = b));
const act = async (p) => { busy(true); err.textContent = ""; const r = await p; busy(false); if (r && r.error) err.textContent = r.error; };
document.getElementById("choose").onclick = () => act(window.homeostat.choose());
document.getElementById("clone").onsubmit = (e) => { e.preventDefault(); err.textContent = "Cloning…"; act(window.homeostat.clone(document.getElementById("url").value)); };
</script></main></body></html>`;
}
