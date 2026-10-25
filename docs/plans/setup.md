# `homeostat setup`: one guided setup for a team's knowledge base

Status: implemented, 2026-10-25 (`homeostat setup`; see [the guide](../guide/setup.md)).

## The problem

`homeostat init` writes `homeostat.yaml`, `knowledge/core/` and the CI files, then prints instructions. Everything after that is manual, and on a real team it took days:
- creating a git-host token and a model credential and storing them as CI variables
- adding a dozen members with their Bitbucket nicknames and roles
- naming reviewers and their Slack member IDs
- listing the code repos
- a Slack webhook
- the pipeline schedules
- CODEOWNERS, the plugin on each laptop, `bootstrap`

Each step had its own way to go wrong: an access token where an API token was needed, a token pasted twice, a variable named for the wrong runtime, a webhook for another team's channel, schedules that didn't exist yet.

## The command

`homeostat setup` is an interactive checklist, run in the KB repo checkout (or an empty folder). It can be run again at any time:
- it detects what is already done
- it asks only for what's missing or broken
- it verifies every step with a real call before moving on

`init` stays as the non-interactive scaffold, and `setup` calls it when there's no `homeostat.yaml` yet.

- `homeostat setup` walks every step that isn't done, in order, and offers each optional step without forcing it.
- `homeostat setup --check` only prints the checklist and exits non-zero if a required step is missing. It is safe in CI, and `doctor` can link to it.
- `homeostat setup --step <name>` runs one step, for example `--step slack` or `--step team`.
- `homeostat setup --join` is the developer-side setup. A teammate runs it once: it installs the Claude Code plugin, points `kb_dir` at their KB checkout, and checks their git name maps to a member.

Without a terminal (`io.ask` absent), setup refuses to prompt, prints the checklist, and says which flags or environment variables would supply each value.

## The checklist

Each step shows ✓ done, ✗ missing, or ○ optional and not set. An optional step always says what you lose without it.

| # | Step | Required? | Verifies with | Stores |
| --- | --- | --- | --- | --- |
| 1 | KB repo and host | required | `origin` remote parses; host detected or chosen | `sources.host`, `sources.kbRepo`, `baseBranch` |
| 2 | Git-host token for CI | required for the daily run | a real call: read the KB repo, read one code repo's PRs, list workspace members | secured CI variable (below) |
| 3 | Code repos | required (at least one) | each repo URL or `owner/name` resolves and its PRs are readable with the token | `repos.<name>.source` (one repo: `sources.repos`) |
| 4 | Areas per repo | optional: without areas every rule applies to the whole repo | proposed from each repo's top-level folders (from the API's file listing, or a local checkout); edited by you | `repos.<name>.areas` |
| 5 | Team | required: you; others optional, but only members' review comments become lessons | workspace/org members listed with nicknames; you pick who joins and set roles | `team.members` (id, handle as written on the host, role, areas) |
| 6 | Reviewers | optional: without them, area owners, then seniors and leads, review the middle band | picked from members | `team.reviewers` |
| 7 | Model credential | required for drafting (without it, `daily --no-reviews` only decides hand-written lessons) | runtime chosen (`api`, `claude-code`, `bedrock`, `vertex`); `api` key checked with a free models call; `claude-code` guides you to `claude setup-token`; cloud runtimes print what the CI identity needs | secured CI variable; `agents.runtime`, model |
| 8 | Slack | optional: without it, nobody is pinged about the review queue or the weekly digest | the webhook gets one test post that you confirm arrived; reviewers' Slack member IDs asked (with where to find them) | secured CI variable; `notifications.slackWebhookEnv`; members' `slack` |
| 9 | Schedules | required for anything to run on its own | Bitbucket: Pipelines schedules created or updated through the API (daily, deep dive weekly, digest weekly); GitHub: the workflow crons already in the files, and Actions enabled | schedules on the KB repo |
| 10 | CODEOWNERS and branch protection | optional but recommended: without protection, anyone can merge unreviewed rules | CODEOWNERS generated; protection read back where the API allows, otherwise the exact settings to click | `.bitbucket/CODEOWNERS` or `.github/CODEOWNERS` |
| 11 | Commit and push | required | `validate` passes; one commit "homeostat: setup" on a branch, or on `main` if you say so | |
| 12 | First base | optional: without it the KB starts empty and fills from reviews | `bootstrap --dry-run` preview, then asks | one PR per repo |
| 13 | Teammates | optional | prints the one-line join command and the plugin install lines | |

## Secrets

- Read hidden from the terminal: never echoed, never written to disk, never logged, never put in a file in the repo. Pasting the same value twice, or whitespace and newlines around it, is cleaned or rejected, which is what went wrong by hand.
- Each is verified before it is stored.
- **Bitbucket:** stored as secured repository variables on the KB repo through the Pipelines variables API (`/repositories/{ws}/{repo}/pipelines_config/variables/`), created or updated by name.
- **GitHub:** stored as Actions secrets through `gh secret set` if `gh` is installed and logged in. Otherwise setup prints the exact `gh` command to run, because encrypting a secret for the REST API needs libsodium, a dependency we don't add.
- Storing needs admin access to the KB repo, which the CI token usually lacks. Setup asks whether to use the same token or a separate one for this one write. If the write is refused, it prints exactly where to paste the value in the UI. The values are never echoed.
- Variable names are the ones the CI files read (`HOMEOSTAT_BITBUCKET_TOKEN`, `HOMEOSTAT_BITBUCKET_EMAIL`, `HOMEOSTAT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, the Slack webhook variable). `--check` reports only whether each exists, never its value.
- Bitbucket token types are explained at the prompt: an Atlassian API token plus its account email (any plan), or a workspace access token (Premium). Setup detects which one was pasted from the verification call.

## What it never does

- Run anything on a schedule on the laptop.
- Store a secret anywhere but the CI variables.
- Push to `main` without asking.
- Read a code repo's contents except for top-level folders (for areas), and the files `bootstrap` previews.

## Implementation notes

- **Where the code lives:** a step registry in `packages/cli/src/setup/`, one module per step, each with `detect()`, `run()` and `optional`/`why`.
- **The config is edited by the same YAML-preserving writer `migrate` uses,** so comments survive.
- **Provider additions behind the existing interfaces:**
  - workspace or org members with nicknames
  - repository variables: list names, create or update
  - Pipelines schedules: list, create, update
  - a repo's top-level folders
  - GitHub's equivalents through the REST API or `gh`

  Each comes with recorded-fixture tests, like the existing provider tests.
- **Tests** drive the whole flow with scripted `io.ask` answers and fake providers. They cover a fresh run, a re-run where everything is done (no prompts), a re-run that fixes one broken step, refusing without a terminal, a storage write refused (falls back to instructions), and the GitHub path without `gh`.
- **Docs:** the quickstart becomes "run `homeostat setup`", with the manual steps kept as a reference; `docs/guide/setup.md` covers each step, and why the optional ones are optional.
