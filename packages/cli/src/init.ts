import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, ID_PATTERN, slugify, validate } from "@kbx/core";
import type { Io } from "./cli.ts";
import { readKbFiles } from "./files.ts";
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
    : `      # handle: "@your-user"   # needed by \`kbx codeowners\``;
  return `# kbx knowledge base config. \`kbx validate\` checks it.
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

# Needed by the curator (kbx curate): the KB repo and the code repos it reads.
# sources:
#   host: github            # or bitbucket
#   kbRepo: your-org/team-kb
#   repos: [your-org/api, your-org/web]
`;
}

const VALIDATE_STEP = "npx --yes kbx@0 validate";
const CURATE_STEP = "npx --yes kbx@0 curate";

interface CiFile {
  path: string;
  content: string;
  /** What to add by hand when the file already exists. */
  snippet: string;
}

const GITHUB_CURATOR = `name: kbx curator

# The daily curator: drafts entries from merged review feedback and opens one PR here.
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: |
          git config user.name "kbx curator"
          git config user.email "kbx-curator@users.noreply.github.com"
      - run: ${CURATE_STEP}
        env:
          GITHUB_TOKEN: \${{ secrets.KBX_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

const CI_FILES: Record<Host, CiFile[]> = {
  github: [
    {
      path: ".github/workflows/kbx.yml",
      content: `name: kbx

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: ${VALIDATE_STEP}
`,
      snippet: `      - run: ${VALIDATE_STEP}`,
    },
    {
      path: ".github/workflows/kbx-curator.yml",
      content: GITHUB_CURATOR,
      snippet: GITHUB_CURATOR,
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
    - step: &kbx-validate
        name: kbx validate
        script:
          - ${VALIDATE_STEP}

pipelines:
  pull-requests:
    "**":
      - step: *kbx-validate
  branches:
    main:
      - step: *kbx-validate
  custom:
    # Scheduled in Repository settings > Pipelines > Schedules (daily).
    kbx-curator:
      - step:
          name: kbx curator
          script:
            - git config user.name "kbx curator"
            - git config user.email "kbx-curator@noreply.invalid"
            - ${CURATE_STEP}
`,
      snippet: `pipelines:
  pull-requests:
    "**":
      - step:
          name: kbx validate
          script:
            - ${VALIDATE_STEP}
  custom:
    kbx-curator:
      - step:
          name: kbx curator
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
Store it as the secured repository variable KBX_BITBUCKET_TOKEN, and your Claude API key as
ANTHROPIC_API_KEY. Then schedule the kbx-curator pipeline daily under
Repository settings > Pipelines > Schedules, and add a sources section to kbx.yaml.`,
  github: `The curator reads PRs from your code repos and opens one PR on this repo each day.
The workflow's GITHUB_TOKEN covers this repo. To read other repos, create a fine-grained
token or GitHub App with:
  code repos:  Pull requests: read, Contents: read
  this repo:   Pull requests: write, Contents: write
Store it as the Actions secret KBX_GITHUB_TOKEN, your Claude API key as ANTHROPIC_API_KEY,
and add a sources section to kbx.yaml.`,
};

export interface InitOptions {
  host?: string;
  member?: string;
  handle?: string;
  force?: boolean;
}

/** `kbx init [dir]`: scaffolds kbx.yaml, knowledge/ and a validate CI file in a KB repo. */
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
  // The hooks log local events under .kbx/; they never belong in the shared repo.
  const gitignore = existsSync(join(root, ".gitignore"))
    ? readFileSync(join(root, ".gitignore"), "utf8")
    : "";
  if (!/^\/?\.kbx\/?$/m.test(gitignore)) {
    writes[".gitignore"] =
      `${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}.kbx/\n`;
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
        "Rerun with --host github|bitbucket --force to add it (--force also rewrites kbx.yaml).\n\n",
    );
  }
  for (const note of notes) io.stdout(`${note}\n\n`);

  io.stdout(
    `Next steps:
  1. Add your teammates and areas to ${CONFIG_FILE}
  2. Give each member a handle, then run kbx codeowners
  3. Write your first entry under knowledge/core/ and run kbx validate
  4. Commit and push
`,
  );
  return 0;
}
