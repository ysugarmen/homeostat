import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Config } from "./config.ts";

/** Path segments that open a page inside a repo on the web (`/src/main/`, `/tree/main`, `/pulls`). */
const REPO_PAGES = new Set([
  "src",
  "tree",
  "blob",
  "raw",
  "commits",
  "commit",
  "branches",
  "pull-requests",
  "pulls",
  "pull",
  "issues",
  "pipelines",
  "actions",
  "wiki",
  "downloads",
  "settings",
  "admin",
  "-",
]);

/** The hosts where a repo is always the two path segments right after the host. */
const KNOWN_HOST = /(^|\.)(github\.com|bitbucket\.org)$/i;

/**
 * `owner/name` from a git remote or a repo's web address, whatever its form:
 * `git@host:owner/name.git`, `ssh://git@host/owner/name`, `https://user:token@host/owner/name.git`,
 * or a browser URL such as `https://bitbucket.org/owner/name/src/main/` or
 * `github.com/owner/name/tree/main`. On GitHub and Bitbucket the repo is the first two path
 * segments after the host; elsewhere, the last two before any page segment. Lowercased.
 */
export function remoteRepo(url: string): string | undefined {
  let text = url.trim();
  if (/^(www\.)?(github\.com|bitbucket\.org)\//i.test(text)) text = `https://${text}`;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(text);
  const where = scp ? { host: scp[1] ?? "", path: scp[2] ?? "" } : safeUrl(text);
  if (!where) return undefined;
  const parts = where.path.split("/").filter(Boolean);
  const page = parts.findIndex((p, i) => i >= 2 && REPO_PAGES.has(p.toLowerCase()));
  const repo = page >= 0 ? parts.slice(0, page) : parts;
  const [owner, name] = KNOWN_HOST.test(where.host) ? repo.slice(0, 2) : repo.slice(-2);
  const bare = name?.replace(/\.git$/i, "");
  return owner && bare ? `${owner}/${bare}`.toLowerCase() : undefined;
}

function safeUrl(url: string): { host: string; path: string } | undefined {
  try {
    const u = new URL(url);
    return { host: u.hostname, path: u.pathname };
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
