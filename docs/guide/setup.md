# Setup

```sh
cd team-kb                       # your clone of the KB repo, or an empty folder with an origin remote
npx --yes homeostat@0.5.2 setup
```

`homeostat setup` is a checklist you can run any number of times. It finds what is already done, asks only for what is missing or broken, and checks each step with a real call before it moves on. A step is marked:

- ✓ done
- ✗ missing or broken, with the reason
- ○ optional and not set, with what you lose without it
- ? unknown: it could not be checked from here (usually: no token to read the CI variables with)

It offers every optional step and never forces one. Each question shows an example answer and, in brackets, the default that an empty answer takes. A required step defaults to yes, an optional one to no.

| Command | What it does |
| --- | --- |
| `homeostat setup` | Walks every step that isn't done, in order |
| `homeostat setup --check` | Prints the checklist, then any [quiet misconfigurations](#quiet-misconfigurations), and asks nothing. Exits 1 while a required step is missing. Safe in CI |
| `homeostat setup --step <name>` | Runs one step, for example `--step slack` or `--step team`, even one that is already done |
| `homeostat setup --join` | The developer side, run once by each teammate (below) |

Without a terminal (in CI, or piped), `setup` asks nothing. It prints the checklist and says which flags or environment variables supply each value: `--host`, `--repo owner/name` (repeatable) and `--runtime`, and the tokens in `HOMEOSTAT_GIT_TOKEN` (with `HOMEOSTAT_GIT_EMAIL` for an Atlassian API token), `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `HOMEOSTAT_SLACK_WEBHOOK`. In a terminal those same variables are used instead of asking.

## The steps

| # | Step | Required? | What it checks | What it stores |
| --- | --- | --- | --- | --- |
| 1 | `host`: KB repo and host | required | the `origin` remote parses; the host is detected or picked from a menu. Without `homeostat.yaml` it runs `init` first | `sources.host`, `sources.kbRepo`, `baseBranch` |
| 2 | `token`: git-host token for CI | required | reads the KB repo, one code repo's PRs, and the workspace or org members ([which token](#git-host-token)) | the secured CI variable `HOMEOSTAT_GIT_TOKEN` |
| 3 | `repos`: code repos | required, at least one | each `owner/name` or URL resolves, and its PRs are readable with the token. A URL copied from the browser works, `/src/main/` or `/tree/main` and all | `sources.repos`; several repos in a new KB get `repos.<name>.source` |
| 4 | `areas`: areas per repo | optional | proposed from each repo's top-level folders (a local checkout next to the KB, else the host's file listing), then edited by you | `repos.<name>.areas` or `areas` |
| 5 | `team`: team | required: you. Others are optional | the workspace or org members are listed, numbered, with their nicknames; you pick yourself, who else joins, and their roles | `team.members` |
| 6 | `reviewers`: reviewers | optional | picked from the members | `team.reviewers` |
| 7 | `model`: model credential | required for drafting | a menu: Claude Console API key, Claude Code login, AWS Bedrock or Google Vertex ([details](#model-credential)) | a secured CI variable; `agents.runtime` |
| 8 | `slack`: Slack | optional | one test post to the webhook, which you confirm arrived; then the reviewers' Slack member IDs | a secured CI variable; `notifications.slackWebhookEnv`; members' `slack` |
| 9 | `codeowners`: CODEOWNERS and branch protection | optional, recommended | writes CODEOWNERS; reads protection back where the token may, else prints the [three settings](#branch-protection) | `.bitbucket/CODEOWNERS` or `CODEOWNERS` |
| 10 | `commit`: commit and push | required | `validate` passes; one commit, `homeostat: setup`, on the branch `homeostat-setup` for review, or on `main` if you say so (an empty repo's first commit goes to `main`) | |
| 11 | `schedules`: schedules | required for anything to run on its own (after the commit: Bitbucket can only schedule a pipeline that is on the branch) | Bitbucket: Pipelines schedules created or enabled through the API (daily run, weekly deep dive, weekly digest when Slack is set), matched by pipeline name. GitHub: the workflows' crons are in the files, and Actions are on | schedules on the KB repo |
| 12 | `bootstrap`: first base | optional | a `bootstrap --dry-run` preview, then asks before anything is sent | one PR per repo |
| 13 | `teammates`: teammates | optional | prints the one line each teammate runs | |

### Why the optional steps are optional

- **Areas.** Without areas, every rule applies to the whole repo. That is fine for a small repo; areas start to matter when a session in one part of a large repo would otherwise get rules for another part.
- **Others in the team.** Only members' review comments become lessons, so a team of one learns only from you. Add people whenever they start reviewing: `homeostat setup --step team`.
- **Reviewers.** Without named reviewers, the owners of a lesson's area review it, then seniors and leads. Name reviewers when you want a few people to own the review queue.
- **Slack.** Without it, nobody is pinged about lessons waiting for a reviewer, and the weekly digest isn't posted. Everything else works; reviewers find the queue with `homeostat review list`.
- **CODEOWNERS and branch protection.** Optional only because setup can't always set protection for you. Without protection, anyone with write access can merge unreviewed rules into what every session reads. Strongly recommended.
- **First base.** Without it, the KB starts empty and fills from reviews over the following weeks. `bootstrap` sends code from your local checkouts to the model, so it never runs without the preview and a yes.
- **Teammates.** Their sessions get no rules until they run `setup --join`. It is a step only so the checklist reminds you to share the line.

## Git-host token

The daily run needs one token that reaches the KB repo and every code repo: it reads review comments on the code repos and opens PRs on the KB repo. Your own account's token works. A separate bot account is optional: it only changes whose name the daily run's PRs show.

**Bitbucket.** Either of:

- **An Atlassian API token** (any plan), created in your Atlassian account settings (Security > API tokens > Create API token with scopes, app Bitbucket), with the scopes:
  - `read:repository:bitbucket`, `write:repository:bitbucket`
  - `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`
  - `read:workspace:bitbucket`, to find reviewers by their nickname
  - `admin:pipeline:bitbucket`, only if setup should store the CI variables and schedules with this same token

  An API token goes with the email of the Atlassian account that created it; setup asks for it and stores it as `HOMEOSTAT_GIT_EMAIL`.
- **A workspace access token** (Bitbucket Premium), with Repositories write and Pull requests write. Leave the email empty: setup tells the two kinds apart by trying the token.

A repository access token reaches one repo only, so it is not enough. Code repos need read access only. Neither setup nor `doctor` calls Bitbucket's `/2.0/user`, so the `read:account` scope is not needed.

Storing a CI variable or a schedule needs admin on the KB repo. Setup tries the token you gave it; if Bitbucket refuses with a 403, it asks once for a token with admin on the KB repo, used for that run only and never stored. Leave it empty to skip, and setup prints where to add the variable by hand.

**GitHub.** A fine-grained token (or a GitHub App) with Contents and Pull requests read on the code repos, read and write on the KB repo, and Members read on the organization. Setup stores it with `gh secret set` (below). Without it, the workflows fall back to their own `GITHUB_TOKEN`, which reaches the KB repo only.

### Clone over HTTPS

Bitbucket does not take your account password for git over HTTPS. Use an API token as the password, with the username `x-bitbucket-api-token-auth`:

```sh
git clone https://x-bitbucket-api-token-auth@bitbucket.org/acme/team-kb.git
# Password: paste an API token with read:repository:bitbucket and write:repository:bitbucket
```

The token above works. An SSH remote (`git@bitbucket.org:acme/team-kb.git`) needs no token. When `origin` is an HTTPS URL on bitbucket.org, setup says this in one line, and again if a push fails. Atlassian's page: [Using API tokens](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).

## Model credential

Setup asks how the agents reach Claude, as a numbered menu. The default is the runtime in `homeostat.yaml` (`api` at first).

1. **Claude Console API key** (`api`, recommended for a team). Create one at console.anthropic.com > Settings > API keys. Setup checks it with a free models call and stores it as `ANTHROPIC_API_KEY`.
2. **Claude Code login** (`claude-code`, for personal use or a Team or Enterprise plan). Every scheduled run then spends that person's own usage limits: a first backfill can take hundreds of calls, and a busy repo's daily run a few hundred more. Prefer an API key for a team, and set `agents.maxCostUsd` either way ([spending cap](agents.md#spending-cap)). In another terminal run `claude setup-token`, then paste what it prints. Setup tries the token with one short `claude -p` call (the cheapest model, one turn, no tools), with the token in that call's environment only. Without Claude Code installed it checks the token's shape instead, and says which it did. It stores the token as `CLAUDE_CODE_OAUTH_TOKEN` and turns on the line in the CI file that installs Claude Code, so the commit step commits it.
3. **AWS Bedrock** (`bedrock`). Setup asks the region. The CI identity needs `bedrock:InvokeModel` on the Claude models there, and AWS credentials in CI (OIDC, or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as secured variables). Setup cannot check them.
4. **Google Vertex** (`vertex`). Setup asks the project id and the region. The CI identity needs `roles/aiplatform.user` on the project, through workload identity or a service-account key in `GOOGLE_APPLICATION_CREDENTIALS`. Setup cannot check them.

## Branch protection

The daily run merges confident rules on its own, which is safe only if nothing else can merge unreviewed. Protect `main` with three settings:

- **Bitbucket** (Repository settings > Branch restrictions, and Merge checks):
  1. Require 1 approval. CODEOWNERS (`.bitbucket/CODEOWNERS`) adds each area's owners as reviewers.
  2. Require a passing build, and turn on "Prevent a merge with unresolved merge checks". Only Bitbucket Premium enforces merge checks; on other plans they are advice, so keep the KB's writers few.
  3. Let only the daily run's token merge without an approval. It merges an entry unreviewed only when every gate in `scoring.autoMerge` passes, after validating the whole knowledge base; if Bitbucket refuses the merge, those lessons wait for a reviewer instead.
- **GitHub** (Settings > Rules > Rulesets, targeting the default branch):
  1. Require a pull request with 1 approval and review from Code Owners.
  2. Require the `validate` check.
  3. Add the daily run's GitHub App (or token user) to the bypass list. Use the App or `HOMEOSTAT_GIT_TOKEN`, not the workflow's `GITHUB_TOKEN`: PRs opened with `GITHUB_TOKEN` do not trigger the validate check.

Setup reads protection back where the token may. A 403 there means the token lacks repository admin; check the settings by hand.

## Secrets

- **Hidden.** Each secret is pasted at a prompt that says "Paste …, then press Enter (nothing shows while you paste)". Paste it there, in the terminal, not anywhere else. It is never printed, logged or written to a file. Every line setup prints is scrubbed of the secrets typed in that run.
- **Cleaned.** Surrounding whitespace and line breaks are trimmed. A value with spaces or line breaks inside, or the same value pasted twice, is refused, and you are asked again. Those were the most common ways a token pasted by hand went wrong.
- **Verified before it is stored.** The git-host token reads the KB repo, a code repo's PRs and the members. The API key lists one model. A Claude Code token answers one short call. The webhook gets one test post. A Bitbucket token is tried as an Atlassian API token (Basic, with its account email) and, when that is refused, as an access token (Bearer); setup tells you which it was.
- **Stored where CI reads it.**
  - Bitbucket: secured repository variables on the KB repo, through the Pipelines variables API, created or updated by name ([admin needed](#git-host-token)).
  - GitHub: Actions secrets, with `gh secret set NAME -R owner/repo` and the value on standard input, when `gh` is installed and logged in. Otherwise setup prints that exact command to run yourself. The REST API needs secrets encrypted with libsodium first, a dependency Homeostat doesn't take.
- **If a write is refused**, setup prints where to paste the value by hand (the repository variables page, or the Actions secrets page) and the variable's name. It never prints the value.
- **Stored just now.** Bitbucket's lists of variables and schedules lag a little behind a write. Anything setup stored or scheduled in a run counts as done for the rest of that run ("stored just now"), without listing again.
- **Stored earlier.** When nothing can check a variable from here (no token in the environment), but `.homeostat/setup.json` says an earlier run stored it, the step shows "stored earlier (checked <date>)" and is not asked again. `homeostat setup --step token` (or `model`, `slack`, `schedules`) redoes it.
- `--check` reports only whether each variable exists, never its value.

The variable names are the ones the CI files read: `HOMEOSTAT_GIT_TOKEN` and, with an Atlassian API token, `HOMEOSTAT_GIT_EMAIL`; `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; and `HOMEOSTAT_SLACK_WEBHOOK`.

### Renamed variables

Up to 0.3.2 the git-host token had a name per host: `HOMEOSTAT_BITBUCKET_TOKEN` and `HOMEOSTAT_BITBUCKET_EMAIL`, or `HOMEOSTAT_GITHUB_TOKEN`. Homeostat still reads them, after the new names, so a knowledge base set up with them keeps working. Nothing renames them for you: `homeostat setup --check` and `homeostat doctor --security` say "works; consider renaming to HOMEOSTAT_GIT_TOKEN".

To rename, first make sure the version in your CI file is newer than 0.3.2 (older versions read only the old names). Then add `HOMEOSTAT_GIT_TOKEN` (and `HOMEOSTAT_GIT_EMAIL`) with the same values, and delete the old variables once a daily run has passed. On GitHub, also replace the token line in `homeostat-curator.yml` and `homeostat-deep-dive.yml` with the one `homeostat init` writes now:

```yaml
          HOMEOSTAT_GIT_TOKEN: ${{ secrets.HOMEOSTAT_GIT_TOKEN || secrets.HOMEOSTAT_GITHUB_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Quiet misconfigurations

Some mistakes fail nothing: every run goes green and quietly does less. `homeostat setup --check` lists them under "Worth fixing" after the checklist, and `homeostat doctor` under "Is anything quietly misconfigured?". Each is a warning with its fix and never changes the exit code:

| Warning | Fix |
| --- | --- |
| the variable named in `notifications.slackWebhookEnv` is not stored as a Bitbucket repository variable or a GitHub Actions secret, so nothing is posted | `homeostat setup --step slack` |
| a Bitbucket schedule for a homeostat pipeline is on another branch than `sources.baseBranch`, or is disabled | `homeostat setup --step schedules`, or enable it in Repository settings > Pipelines > Schedules |
| the last daily run reached `agents.curator.judgeCalls`, so lessons it would have merged went to a reviewer unjudged | raise `agents.curator.judgeCalls` in `homeostat.yaml` |
| a CI file pins a homeostat older than the CLI you run | change the version to the CLI's and commit |

Listing CI variables and schedules needs the token in the environment, and on Bitbucket admin on the KB repo; without it those two checks say nothing. The judge check reads the state branch as this clone last fetched it.

## Teammates: `setup --join`

Each developer runs this once, in their clone of the KB:

```sh
npx --yes homeostat@0.5.2 setup --join
```

It does three things:

1. Installs the Claude Code plugin: `claude plugin marketplace add ysugarmen/homeostat` and `claude plugin install homeostat@homeostat`.
2. Sets the plugin's `kb_dir` to this checkout, with `claude plugin configure homeostat@homeostat --values-stdin`. If your Claude Code is too old for that, it prints the manual step instead: `/plugin` > homeostat > Configure, `kb_dir`.
3. Checks that your `git config user.name` maps to a member of the team. If it doesn't, your lessons stay on your machine; ask a lead to run `homeostat setup --step team`.

It asks nothing, so it also works from a script.

## What it never does

- Runs anything on a schedule on your laptop.
- Stores a secret anywhere but the CI variables.
- Pushes to `main` without asking.
- Renames your CI variables.
- Reads a code repo's contents beyond its top-level folder names (for areas), and the files `bootstrap` previews.
- Regenerates your `homeostat.yaml`. Every change is an in-place edit, so your comments and ordering survive.

## In the dashboard

The Overview page of `homeostat dashboard` has a Setup card. It shows a bar of the required steps done, and the checklist, with the `homeostat setup --step` command that fixes each missing step. The dashboard makes no network calls and holds no tokens, so it shows two kinds of row:

- Steps it can decide from the files: the config, CODEOWNERS, the CI files, documents.
- Steps only the git host can confirm: the token and the model credential being stored, the schedules, the webhook. For these it shows the last result that `homeostat setup` or `setup --check` recorded on this machine, with its date. The record is `.homeostat/setup.json`, which git ignores; it holds each step's state, when it was checked and a short reason, never a secret.

A last line shows this laptop's `setup --join` result. Until every required step is done, the card leads the page. The shared build (`homeostat dashboard --build`) shows only the rows the files decide, since the record stays on each laptop.
