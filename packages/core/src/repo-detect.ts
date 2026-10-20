import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Config } from "./config.ts";

/**
 * `owner/name` from a git remote URL, whatever its form: `git@host:owner/name.git`,
 * `ssh://git@host/owner/name`, `https://user:token@host/owner/name.git`. Lowercased.
 */
export function remoteRepo(url: string): string | undefined {
  const path = /^[\w.-]+@[^:/]+:(.+)$/.exec(url.trim())?.[1] ?? safeUrlPath(url.trim());
  const parts = path
    ?.replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (!parts || parts.length < 2) return undefined;
  return parts.slice(-2).join("/").toLowerCase();
}

function safeUrlPath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Which of a multi-repo KB's repos a checkout is: its remote matched against repos.*.source,
 * then its folder name against the short names. Undefined for a one-repo KB, or a checkout
 * that is none of them (a session there gets shared rules only).
 */
export function repoFor(
  config: Pick<Config, "repos">,
  checkout: { remote?: string | undefined; folder?: string | undefined },
): string | undefined {
  if (!config.repos) return undefined;
  const fromRemote = checkout.remote ? remoteRepo(checkout.remote) : undefined;
  if (fromRemote) {
    const hit = Object.entries(config.repos).find(([, r]) => r.source.toLowerCase() === fromRemote);
    if (hit) return hit[0];
  }
  const folder = checkout.folder?.toLowerCase();
  return folder && Object.hasOwn(config.repos, folder) ? folder : undefined;
}

/** The repo a folder on disk belongs to: asks git for its origin and top level, then repoFor. */
export function detectRepo(dir: string, config: Pick<Config, "repos">): string | undefined {
  if (!config.repos) return undefined;
  const run = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };
  const top = run("rev-parse", "--show-toplevel");
  return repoFor(config, {
    remote: run("remote", "get-url", "origin"),
    folder: basename(top ?? dir),
  });
}
