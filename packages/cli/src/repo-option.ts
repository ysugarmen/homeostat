import { type Config, detectRepo, isMultiRepo, repoForSource, repoNames } from "@homeostat/core";
import { CliError } from "./provider.ts";

/**
 * The repo a new rule or document belongs to, in a multi-repo KB: the PR's (for a comment URL),
 * else --repo, else the checkout's. Undefined for --shared (knowledge/core/) and in a one-repo
 * KB. Fails when it cannot tell, rather than guess.
 */
export function resolveRepo(
  config: Config,
  opts: {
    repo?: string | undefined;
    shared?: boolean | undefined;
    prRepo?: string | undefined;
    /** A code checkout to identify by its remote, when there is one. */
    checkout?: string | undefined;
  },
): string | undefined {
  if (!isMultiRepo(config)) {
    if (opts.repo || opts.shared)
      throw new CliError("--repo and --shared need repos in homeostat.yaml");
    return undefined;
  }
  const names = repoNames(config);
  if (opts.repo && opts.shared) throw new CliError("pass --repo or --shared, not both");
  if (opts.repo && !names.includes(opts.repo)) {
    throw new CliError(`--repo ${opts.repo} is not one of repos (${names.join(", ")})`);
  }
  if (opts.shared) return undefined;
  const repo =
    (opts.prRepo ? repoForSource(config, opts.prRepo) : undefined) ??
    opts.repo ??
    (opts.checkout ? detectRepo(opts.checkout, config) : undefined);
  if (!repo) {
    throw new CliError(
      `which repo is this for? pass --repo <name> (one of ${names.join(", ")}), or --shared for every repo`,
    );
  }
  return repo;
}
