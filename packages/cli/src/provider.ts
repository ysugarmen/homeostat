import { BitbucketProvider, GitHubProvider, type Provider } from "@homeostat/core";
import type { Io } from "./cli.ts";

/** A problem the user can fix (missing token, bad option); printed without a stack trace. */
export class CliError extends Error {}

export const TOKEN_VARS = {
  bitbucket: ["HOMEOSTAT_BITBUCKET_TOKEN"],
  github: ["HOMEOSTAT_GITHUB_TOKEN", "GITHUB_TOKEN"],
} as const;

/** The provider for `host`, authenticated from the environment; `io.provider` wins in tests. */
export function providerFor(host: "bitbucket" | "github", io: Io, purpose: string): Provider {
  if (io.provider) return io.provider;
  const vars: readonly string[] = TOKEN_VARS[host];
  const token = vars.map((v) => io.env?.[v]).find(Boolean);
  if (!token) throw new CliError(`set ${vars.join(" or ")} to ${purpose}`);
  const opts = { token, ...(io.fetch ? { fetch: io.fetch } : {}) };
  return host === "bitbucket" ? new BitbucketProvider(opts) : new GitHubProvider(opts);
}
