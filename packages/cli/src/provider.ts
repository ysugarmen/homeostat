import { BitbucketProvider, GitHubProvider, type Provider } from "@homeostat/core";
import type { Io } from "./cli.ts";

/** A problem the user can fix (missing token, bad option); printed without a stack trace. */
export class CliError extends Error {}

export type GitHost = "bitbucket" | "github";

/** The git-host token, on either host. */
export const GIT_TOKEN_VAR = "HOMEOSTAT_GIT_TOKEN";
/** With an Atlassian API token in HOMEOSTAT_GIT_TOKEN, the email of the account that created it. */
export const GIT_EMAIL_VAR = "HOMEOSTAT_GIT_EMAIL";

/**
 * The names before HOMEOSTAT_GIT_TOKEN and HOMEOSTAT_GIT_EMAIL. Still read, after the new names,
 * so a knowledge base set up with them keeps working; nothing renames them for you.
 */
export const LEGACY_TOKEN_VAR: Record<GitHost, string> = {
  bitbucket: "HOMEOSTAT_BITBUCKET_TOKEN",
  github: "HOMEOSTAT_GITHUB_TOKEN",
};
export const LEGACY_EMAIL_VAR = "HOMEOSTAT_BITBUCKET_EMAIL";

/** Where the token is read from, in order. GitHub Actions' own GITHUB_TOKEN comes last. */
export const TOKEN_VARS: Record<GitHost, readonly string[]> = {
  bitbucket: [GIT_TOKEN_VAR, LEGACY_TOKEN_VAR.bitbucket],
  github: [GIT_TOKEN_VAR, LEGACY_TOKEN_VAR.github, "GITHUB_TOKEN"],
};
export const EMAIL_VARS: readonly string[] = [GIT_EMAIL_VAR, LEGACY_EMAIL_VAR];

/** What a missing token's message names: the new variable, and GitHub's built-in fallback. */
export const tokenHint = (host: GitHost) =>
  host === "github" ? `${GIT_TOKEN_VAR} or GITHUB_TOKEN` : GIT_TOKEN_VAR;

export interface EnvAuth {
  token: string;
  user?: string;
  /** The variable the token came from. */
  from: string;
}

/** The git-host token (and, on Bitbucket, its account email) from the environment. */
export function envAuth(
  host: GitHost,
  env: Record<string, string | undefined> | undefined,
): EnvAuth | undefined {
  const from = TOKEN_VARS[host].find((v) => env?.[v]);
  const token = from ? env?.[from] : undefined;
  if (!from || !token) return undefined;
  const user = host === "bitbucket" ? EMAIL_VARS.map((v) => env?.[v]).find(Boolean) : undefined;
  return { token, from, ...(user ? { user } : {}) };
}

/** The provider for `host`, authenticated from the environment; `io.provider` wins in tests. */
export function providerFor(host: GitHost, io: Io, purpose: string): Provider {
  if (io.provider) return io.provider;
  const auth = envAuth(host, io.env);
  if (!auth) throw new CliError(`set ${tokenHint(host)} to ${purpose}`);
  const opts = {
    token: auth.token,
    ...(auth.user ? { user: auth.user } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
  };
  return host === "bitbucket" ? new BitbucketProvider(opts) : new GitHubProvider(opts);
}
