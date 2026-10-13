import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, ID_PATTERN, readKbFiles, slugify, validate } from "@homeostat/core";
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

scoring:
  autoMergeThreshold: 3

distribution:
  tokenBudget: 2000

# Needed by the curator (homeostat curate): the KB repo and the code repos it reads.
# sources:
#   host: github            # or bitbucket
#   kbRepo: your-org/team-kb
#   repos: [your-org/api, your-org/web]
`;
}

const VALIDATE_STEP = "npx --yes homeostat@0 validate";
const CURATE_STEP = "npx --yes homeostat@0 curate";
const DEEP_DIVE_STEP = "npx --yes homeostat@0 deep-dive";
/** The agents default to the Claude Code runtime, so their CI jobs install Claude Code. */
const INSTALL_CLAUDE = "npm install -g @anthropic-ai/claude-code";

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
          GITHUB_TOKEN: \${{ secrets.HOMEOSTAT_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
          # A Claude Console API key (agents.runtime: api, the default).
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          # Or, with agents.runtime: claude-code, a token from \`claude setup-token\`:
          # CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`;

const GITHUB_CURATOR = githubAgentWorkflow(
  "curator",
  "The daily curator: drafts entries from merged review feedback and opens one PR here.",
  "0 6 * * *",
  CURATE_STEP,
);
const GITHUB_DEEP_DIVE = githubAgentWorkflow(
  "deep-dive",
  "The weekly deep dive: merges near-duplicates, marks contradictions, retires stale entries.",
  "0 7 * * 1",
  DEEP_DIVE_STEP,
);

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
  ],
  bitbucket: [
    {
      path: "bitbucket-pipelines.yml",
      content: `image: node:24

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
  custom:
    # Scheduled in Repository settings > Pipelines > Schedules (daily).
    homeostat-curator:
      - step:
          name: homeostat curator
          script:
            - git config user.name "homeostat curator"
            - git config user.email "homeostat-curator@noreply.invalid"
            # With agents.runtime: claude-code, also: - ${INSTALL_CLAUDE}
            - ${CURATE_STEP}
    # Scheduled weekly the same way.
    homeostat-deep-dive:
      - step:
          name: homeostat deep dive
          script:
            - git config user.name "homeostat deep-dive"
            - git config user.email "homeostat-deep-dive@noreply.invalid"
            # With agents.runtime: claude-code, also: - ${INSTALL_CLAUDE}
            - ${DEEP_DIVE_STEP}
`,
      snippet: `pipelines:
  pull-requests:
    "**":
      - step:
          name: homeostat validate
          script:
            - ${VALIDATE_STEP}
  custom:
    homeostat-curator:
      - step:
          name: homeostat curator
          script:
            - ${CURATE_STEP}`,
    },
  ],
};

const TOKEN_HELP: Record<Host, string> = {
  bitbucket: `The curator reads PRs from your code repos and opens one PR on this repo each day.
Ask a workspace admin for a workspace access token with:
  code repos:  pullrequest:read, repository:read
  this repo:   pullrequest:write, repository:write
Store it as the secured repository variable HOMEOSTAT_BITBUCKET_TOKEN, and a Claude Console API key
as ANTHROPIC_API_KEY. (A personal Claude subscription token is for personal, non-commercial use
only; a team KB needs a Console key or a Team/Enterprise plan.) Then schedule the homeostat-curator pipeline daily and homeostat-deep-dive weekly under
Repository settings > Pipelines > Schedules, and add a sources section to homeostat.yaml.`,
  github: `The curator reads PRs from your code repos and opens one PR on this repo each day.
The workflow's GITHUB_TOKEN covers this repo. To read other repos, create a fine-grained
token or GitHub App with:
  code repos:  Pull requests: read, Contents: read
  this repo:   Pull requests: write, Contents: write
Store it as the Actions secret HOMEOSTAT_GITHUB_TOKEN, and a Claude Console API key as
ANTHROPIC_API_KEY. (A personal Claude subscription token is for personal, non-commercial use only;
a team KB needs a Console key or a Team/Enterprise plan.) Then add a sources section to homeostat.yaml.`,
};

export interface InitOptions {
  host?: string;
  member?: string;
  handle?: string;
  force?: boolean;
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

  if (host) {
    const source = opts.host ? "--host" : "the origin remote";
    io.stdout(`Git host: ${HOST_NAME[host]} (from ${source})\n${TOKEN_HELP[host]}\n\n`);
  } else {
    io.stdout(
      "Skipped CI: could not detect the git host from the origin remote.\n" +
        "Rerun with --host github|bitbucket --force to add it (--force also rewrites homeostat.yaml).\n\n",
    );
  }
  for (const note of notes) io.stdout(`${note}\n\n`);

  io.stdout(
    `Next steps:
  1. Add your teammates and areas to ${CONFIG_FILE}
  2. Give each member a handle, then run homeostat codeowners
  3. Write your first entry under knowledge/core/ and run homeostat validate
  4. Commit and push
`,
  );
  return 0;
}
