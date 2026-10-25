import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, ID_PATTERN, readKbFiles, slugify, VERSION, validate } from "@homeostat/core";
import type { Io } from "./cli.ts";
import { formatIssues, painter } from "./format.ts";
import { git } from "./git.ts";

export type Host = "github" | "bitbucket";
export const HOSTS: readonly Host[] = ["github", "bitbucket"];

const HOST_NAME: Record<Host, string> = { github: "GitHub", bitbucket: "Bitbucket" };

/** Matches scp-style (`git@host:org/repo`) and URL-style (`https://user@host/org/repo`) remotes. */
export function detectHost(remoteUrl: string): Host | undefined {
  const host = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]/.exec(remoteUrl.trim())?.[1];
  if (host === "github.com") return "github";
  if (host === "bitbucket.org") return "bitbucket";
  return undefined;
}

export function memberIdFrom(name: string | undefined): string {
  return slugify(name) ?? "owner";
}

function configTemplate(member: string, handle: string | undefined): string {
  const handleLine = handle
    ? `      handle: "${handle}"`
    : `      # handle: "@your-user"   # needed by \`homeostat codeowners\``;
  return `# homeostat knowledge base config. \`homeostat validate\` checks it.
version: 1

team:
  members:
    - id: ${member}
${handleLine}
      role: senior
      areas: [core]

# Area name -> path globs in your code repos. \`core\` is implicit and applies everywhere.
# Example:
#   payments: ["services/payments/**"]
areas: {}

# The daily run decides each lesson by a 0-100 confidence: it merges at 70+ (80+ for core),
# declines below 35, and sends the rest to a reviewer. Tune it under scoring.confidence.
# scoring:
#   confidence: { accept: 70, coreAccept: 80, decline: 35 }

distribution:
  tokenBudget: 2000

# The weekly digest (homeostat digest) posts to the Slack webhook in this CI secret.
# notifications:
#   slackWebhookEnv: HOMEOSTAT_SLACK_WEBHOOK

# Needed by the daily run (homeostat daily): the KB repo and the code repos it reads.
# sources:
#   host: github            # or bitbucket
#   kbRepo: your-org/team-kb
#   repos: [your-org/api, your-org/web]
`;
}

const VALIDATE_STEP = `npx --yes homeostat@${VERSION} validate`;
const DAILY_STEP = `npx --yes homeostat@${VERSION} daily`;
const DEEP_DIVE_STEP = `npx --yes homeostat@${VERSION} deep-dive`;
const DIGEST_STEP = `npx --yes homeostat@${VERSION} digest`;

/** The weekly digest: no model, no write access; it only posts to the team's Slack webhook. */
const GITHUB_DIGEST = `name: homeostat digest

# The weekly digest: new and changed rules, document updates, the review queue and flags,
# posted to Slack. Set notifications.slackWebhookEnv in homeostat.yaml and the secret it names.
on:
  schedule:
    - cron: "0 8 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: ${DIGEST_STEP}
        env:
          HOMEOSTAT_SLACK_WEBHOOK: \${{ secrets.HOMEOSTAT_SLACK_WEBHOOK }}
`;
/** With agents.runtime: claude-code, the agents' CI jobs also install Claude Code. */
// npm 11 skips install scripts unless allowed, and Claude Code's postinstall sets up the CLI.
const INSTALL_CLAUDE =
  "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code";

interface CiFile {
  path: string;
  content: string;
  /** What to add by hand when the file already exists. */
  snippet: string;
}

/** A scheduled GitHub Actions workflow that runs one homeostat agent and may open a PR here. */
const githubAgentWorkflow = (
  name: string,
  purpose: string,
  cron: string,
  command: string,
  extraEnv = "",
) => `name: homeostat ${name}

# ${purpose}
on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: |
          git config user.name "homeostat ${name}"
          git config user.email "homeostat@users.noreply.github.com"
      # With agents.runtime: claude-code (Team/Enterprise plans only, for a team KB), uncomment:
      # - run: ${INSTALL_CLAUDE}
      - run: ${command}
        env:
          # The git-host token (HOMEOSTAT_GITHUB_TOKEN is its old name, still read). Without
          # either, the workflow's own GITHUB_TOKEN, which reaches this repo only.
          HOMEOSTAT_GIT_TOKEN: \${{ secrets.HOMEOSTAT_GIT_TOKEN || secrets.HOMEOSTAT_GITHUB_TOKEN }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          # A Claude Console API key (agents.runtime: api, the default).
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # Or, with agents.runtime: claude-code, a token from \`claude setup-token\`:
          # CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}${extraEnv}
`;

const GITHUB_CURATOR = githubAgentWorkflow(
  "curator",
  "The daily run: one PR per developer from their lessons and the reviews on their PRs, merged, declined or sent to a reviewer by confidence.",
  "0 6 * * *",
  DAILY_STEP,
  "\n          # Optional: where the morning review-queue notice goes (notifications.slackWebhookEnv).\n          HOMEOSTAT_SLACK_WEBHOOK: \${{ secrets.HOMEOSTAT_SLACK_WEBHOOK }}",
);
const GITHUB_DEEP_DIVE = githubAgentWorkflow(
  "deep-dive",
  "The weekly deep dive: merges near-duplicates, marks contradictions, retires stale entries.",
  "0 7 * * 1",
  DEEP_DIVE_STEP,
);

const BITBUCKET_PIPELINES = `image: node:24

clone:
  depth: full

definitions:
  steps:
    - step: &homeostat-validate
        name: homeostat validate
        script:
          - ${VALIDATE_STEP}

pipelines:
  pull-requests:
    "**":
      - step: *homeostat-validate
  branches:
    main:
      - step: *homeostat-validate
  # The agents read the repository variables HOMEOSTAT_GIT_TOKEN (with HOMEOSTAT_GIT_EMAIL for an
  # Atlassian API token; the old names HOMEOSTAT_BITBUCKET_TOKEN and _EMAIL still work) and
  # ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
  custom:
    # Scheduled in Repository settings > Pipelines > Schedules (daily).
    homeostat-curator:
      - step:
          name: homeostat curator
          script:
            - git config user.name "homeostat curator"
            - git config user.email "homeostat-curator@noreply.invalid"
            # With agents.runtime: claude-code, also: - ${INSTALL_CLAUDE}
            - ${DAILY_STEP}
    # Scheduled weekly the same way.
    homeostat-deep-dive:
      - step:
          name: homeostat deep dive
          script:
            - git config user.name "homeostat deep-dive"
            - git config user.email "homeostat-deep-dive@noreply.invalid"
            # With agents.runtime: claude-code, also: - ${INSTALL_CLAUDE}
            - ${DEEP_DIVE_STEP}
    # Scheduled weekly; posts to the webhook in the secured variable HOMEOSTAT_SLACK_WEBHOOK.
    homeostat-digest:
      - step:
          name: homeostat digest
          script:
            - ${DIGEST_STEP}
`;

const CI_FILES: Record<Host, CiFile[]> = {
  github: [
    {
      path: ".github/workflows/homeostat.yml",
      content: `name: homeostat

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: ${VALIDATE_STEP}
`,
      snippet: `      - run: ${VALIDATE_STEP}`,
    },
    {
      path: ".github/workflows/homeostat-curator.yml",
      content: GITHUB_CURATOR,
      snippet: GITHUB_CURATOR,
    },
    {
      path: ".github/workflows/homeostat-deep-dive.yml",
      content: GITHUB_DEEP_DIVE,
      snippet: GITHUB_DEEP_DIVE,
    },
    {
      path: ".github/workflows/homeostat-digest.yml",
      content: GITHUB_DIGEST,
      snippet: GITHUB_DIGEST,
    },
  ],
  bitbucket: [
    {
      path: "bitbucket-pipelines.yml",
      content: BITBUCKET_PIPELINES,
      // One file holds every pipeline, so an existing one needs all of them merged in.
      snippet: BITBUCKET_PIPELINES,
    },
  ],
};

/** The setup guide; `guide("anchor")` links one section of it. */
export const GUIDE_URL = "https://github.com/ysugarmen/homeostat/blob/main/docs/guide/setup.md";
export const guide = (anchor: string) => `${GUIDE_URL}#${anchor}`;

/** Which token to create and its scopes, in two lines; the guide has the rest. */
export const TOKEN_SCOPES: Record<Host, string> = {
  bitbucket: `Create an Atlassian API token (your own account works) with the scopes read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:workspace:bitbucket, and admin:pipeline:bitbucket if setup should store it for you.
Or, on Bitbucket Premium, a workspace access token. More: ${guide("git-host-token")}`,
  github: `Create a fine-grained token (your own account works): Contents and Pull requests, read on the code repos and read and write on the KB repo; Members read on the org.
More: ${guide("git-host-token")}`,
};

const TOKEN_HELP: Record<Host, string> = {
  bitbucket: `The daily run (the homeostat-curator pipeline) reads PRs from your code repos and opens one
PR per developer on this repo each day. It needs one token that reaches all of them.
${TOKEN_SCOPES.bitbucket}
Store it as the secured repository variable HOMEOSTAT_GIT_TOKEN; for an API token, also store the
email of the account that created it as HOMEOSTAT_GIT_EMAIL. Add a Claude Console API key as
ANTHROPIC_API_KEY. (A personal Claude subscription token is for personal, non-commercial use only;
a team KB needs a Console key or a Team/Enterprise plan.) Then schedule the homeostat-curator
pipeline daily, and homeostat-deep-dive and homeostat-digest weekly, under
Repository settings > Pipelines > Schedules, and add a sources section to homeostat.yaml.
homeostat setup does all of this.`,
  github: `The daily run (homeostat-curator.yml) reads PRs from your code repos and opens one PR per
developer on this repo each day. The workflow's GITHUB_TOKEN covers this repo; to read other repos:
${TOKEN_SCOPES.github}
Store it as the Actions secret HOMEOSTAT_GIT_TOKEN, and a Claude Console API key as
ANTHROPIC_API_KEY. (A personal Claude subscription token is for personal, non-commercial use only;
a team KB needs a Console key or a Team/Enterprise plan.) Then add a sources section to homeostat.yaml.
homeostat setup does all of this.`,
};

/** The three branch-protection settings, short, for `homeostat setup`; the guide explains them. */
export const PROTECTION_SHORT: Record<Host, string> = {
  bitbucket: `Protect main in Repository settings > Branch restrictions: require 1 approval, require a
passing build, and let only the daily run's token merge without approval.
More: ${guide("branch-protection")}`,
  github: `Protect main in Settings > Rules > Rulesets: require a pull request with 1 approval from Code
Owners, require the "validate" check, and let only the daily run's token or App bypass.
More: ${guide("branch-protection")}`,
};

const CLAUDE_INSTALL_COMMENTED: Record<Host, string> = {
  github: `      # - run: ${INSTALL_CLAUDE}`,
  bitbucket: `# With agents.runtime: claude-code, also: - ${INSTALL_CLAUDE}`,
};
const CLAUDE_INSTALL_ON: Record<Host, string> = {
  github: `      - run: ${INSTALL_CLAUDE}`,
  bitbucket: `- ${INSTALL_CLAUDE}`,
};
const CLAUDE_FILES: Record<Host, string[]> = {
  github: [".github/workflows/homeostat-curator.yml", ".github/workflows/homeostat-deep-dive.yml"],
  bitbucket: ["bitbucket-pipelines.yml"],
};

/**
 * With agents.runtime: claude-code, the agents' CI jobs install Claude Code and, on GitHub, pass
 * CLAUDE_CODE_OAUTH_TOKEN: the lines `init` wrote commented out are turned on. `edited` lists the
 * files changed; `manual` the ones whose lines were not found, with the line to add by hand.
 */
export function useClaudeCodeInCi(
  root: string,
  host: Host,
): { edited: string[]; manual: { path: string; line: string }[] } {
  const edited: string[] = [];
  const manual: { path: string; line: string }[] = [];
  for (const path of CLAUDE_FILES[host]) {
    const full = join(root, path);
    const text = existsSync(full) ? readFileSync(full, "utf8") : "";
    let next = text.split(CLAUDE_INSTALL_COMMENTED[host]).join(CLAUDE_INSTALL_ON[host]);
    if (host === "github")
      next = next
        .replace(
          /^ *# With agents\.runtime: claude-code \(Team\/Enterprise plans only, for a team KB\), uncomment:\n/m,
          "      # agents.runtime: claude-code (Team/Enterprise plans only, for a team KB):\n",
        )
        .replace(/^( *)# (CLAUDE_CODE_OAUTH_TOKEN: )/m, "$1$2");
    if (!next.includes(INSTALL_CLAUDE) || next.includes(CLAUDE_INSTALL_COMMENTED[host])) {
      manual.push({ path, line: CLAUDE_INSTALL_ON[host].trim() });
      continue;
    }
    if (next !== text) {
      writeFileSync(full, next);
      edited.push(path);
    }
  }
  return { edited, manual };
}

/**
 * Auto-merge is safe only if nothing else can merge unreviewed: protect the base branch, require
 * the validate check and a CODEOWNERS approval, and let only the daily run's token skip the approval.
 */
export const PROTECTION_HELP: Record<Host, string> = {
  bitbucket: `Protect main (Repository settings > Branch restrictions and Merge checks):
  - require a pull request, 1 approval and a passing build, and turn on "Prevent a merge with
    unresolved merge checks". Only Bitbucket Premium enforces merge checks; on other plans they
    are advice, so keep the KB's writers few.
  - homeostat codeowners writes .bitbucket/CODEOWNERS, which adds each area's owners as reviewers.
  - let only the daily run's token merge without an approval. It merges an entry unreviewed only
    when every gate in scoring.autoMerge passes, after validating the whole knowledge base itself;
    if Bitbucket refuses the merge, those lessons wait for a reviewer instead.`,
  github: `Protect main (Settings > Rules > Rulesets, targeting the default branch):
  - require a pull request with 1 approval, review from Code Owners, and the "validate" check
  - add the daily run's GitHub App (or token user) to the bypass list. It merges an entry unreviewed
    only when every gate in scoring.autoMerge passes, after validating the whole knowledge base
    itself; everything else waits for a reviewer. Use the App or HOMEOSTAT_GIT_TOKEN, not the
    workflow's GITHUB_TOKEN: PRs opened with GITHUB_TOKEN do not trigger the validate check.`,
};

export interface InitOptions {
  host?: string;
  member?: string;
  handle?: string;
  force?: boolean;
  /** False when `homeostat setup` scaffolds: it checks each step instead of printing the guide. */
  guide?: boolean;
}

/** `homeostat init [dir]`: scaffolds homeostat.yaml, knowledge/ and a validate CI file in a KB repo. */
export function runInit(dir: string, opts: InitOptions, io: Io): number {
  const root = resolve(dir);
  const paint = painter(io);

  if (opts.host !== undefined && !HOSTS.includes(opts.host as Host)) {
    io.stderr(`unknown --host "${opts.host}"; use ${HOSTS.join(" or ")}\n`);
    return 1;
  }
  const member = opts.member ?? memberIdFrom(git(root, "config", "user.name"));
  if (!ID_PATTERN.test(member)) {
    io.stderr(`--member "${member}" must be lowercase letters, digits and single hyphens\n`);
    return 1;
  }
  if (existsSync(join(root, CONFIG_FILE)) && !opts.force) {
    io.stdout(`${CONFIG_FILE} already exists; use --force to overwrite\n`);
    return 1;
  }

  const remote = git(root, "remote", "get-url", "origin");
  const detected = remote ? detectHost(remote) : undefined;
  const host = (opts.host as Host | undefined) ?? detected;

  const writes: Record<string, string> = { [CONFIG_FILE]: configTemplate(member, opts.handle) };
  if (!existsSync(join(root, "knowledge/core"))) writes["knowledge/core/.gitkeep"] = "";
  // The hooks log local events under .homeostat/; they never belong in the shared repo.
  const gitignore = existsSync(join(root, ".gitignore"))
    ? readFileSync(join(root, ".gitignore"), "utf8")
    : "";
  if (!/^\/?\.homeostat\/?$/m.test(gitignore)) {
    writes[".gitignore"] =
      `${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}.homeostat/\n`;
  }
  const notes: string[] = [];
  if (host) {
    for (const ci of CI_FILES[host]) {
      if (existsSync(join(root, ci.path))) {
        notes.push(`${ci.path} already exists; add this to it:\n${ci.snippet}`);
      } else {
        writes[ci.path] = ci.content;
      }
    }
  }

  // Validate the result in memory so a bad option never leaves a half-written KB behind.
  const files = { ...readKbFiles(root), [CONFIG_FILE]: writes[CONFIG_FILE] ?? "" };
  const result = validate(files);
  if (!result.ok) {
    io.stdout(`${formatIssues(result.issues, io).text}nothing written\n`);
    return 1;
  }

  for (const [path, content] of Object.entries(writes)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    io.stdout(`created ${path}\n`);
  }
  io.stdout(
    `${paint("green", "✓")} knowledge base is valid (${result.entries.length} entries)\n\n`,
  );
  if (opts.guide === false) {
    for (const note of notes) io.stdout(`${note}\n\n`);
    return 0;
  }

  if (host) {
    const source = opts.host ? "--host" : "the origin remote";
    io.stdout(
      `Git host: ${HOST_NAME[host]} (from ${source})\n${TOKEN_HELP[host]}\n\n${PROTECTION_HELP[host]}\n\n`,
    );
  } else {
    io.stdout(
      "Skipped CI: could not detect the git host from the origin remote.\n" +
        "Rerun with --host github|bitbucket --force to add it (--force also rewrites homeostat.yaml).\n\n",
    );
  }
  for (const note of notes) io.stdout(`${note}\n\n`);

  io.stdout(
    `Next steps (homeostat setup walks you through each one and checks it):
  1. Add your teammates and areas to ${CONFIG_FILE}
  2. Give each member a handle, then run homeostat codeowners
  3. Write your first entry under knowledge/core/ and run homeostat validate
  4. Commit and push
  5. Build a first base from your repos' docs, schemas and deploy files:
     homeostat bootstrap --dry-run shows what it would read and cost, then homeostat bootstrap
`,
  );
  return 0;
}
