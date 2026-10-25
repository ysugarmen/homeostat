# Setup

```sh
cd team-kb                       # your clone of the KB repo, or an empty folder with an origin remote
npx --yes homeostat@0.3.2 setup
```

`homeostat setup` is a checklist you can run any number of times. It finds what is already done, asks only for what is missing or broken, and checks each step with a real call before it moves on. A step is marked:

- ✓ done
- ✗ missing or broken, with the reason
- ○ optional and not set, with what you lose without it
- ? unknown: it could not be checked from here (usually: no token to read the CI variables with)

It offers every optional step and never forces one.

| Command | What it does |
| --- | --- |
| `homeostat setup` | Walks every step that isn't done, in order |
| `homeostat setup --check` | Prints the checklist and asks nothing. Exits 1 while a required step is missing. Safe in CI |
| `homeostat setup --step <name>` | Runs one step, for example `--step slack` or `--step team` |
| `homeostat setup --join` | The developer side, run once by each teammate (below) |

Without a terminal (in CI, or piped), `setup` asks nothing. It prints the checklist and says which flags or environment variables supply each value: `--host`, `--repo owner/name` (repeatable) and `--runtime`, and the tokens in `HOMEOSTAT_BITBUCKET_TOKEN` (with `HOMEOSTAT_BITBUCKET_EMAIL`), `HOMEOSTAT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `HOMEOSTAT_SLACK_WEBHOOK`. In a terminal those same variables are used instead of asking.

## The steps

| # | Step | Required? | What it checks | What it stores |
| --- | --- | --- | --- | --- |
| 1 | `host`: KB repo and host | required | the `origin` remote parses; the host is detected or chosen. Without `homeostat.yaml` it runs `init` first | `sources.host`, `sources.kbRepo`, `baseBranch` |
| 2 | `token`: git-host token for CI | required | reads the KB repo, one code repo's PRs, and the workspace or org members | a secured CI variable |
| 3 | `repos`: code repos | required, at least one | each `owner/name` or URL resolves, and its PRs are readable with the token | `sources.repos`; several repos in a new KB get `repos.<name>.source` |
| 4 | `areas`: areas per repo | optional | proposed from each repo's top-level folders (a local checkout next to the KB, else the host's file listing), then edited by you | `repos.<name>.areas` or `areas` |
| 5 | `team`: team | required: you. Others are optional | the workspace or org members are listed with their nicknames; you pick yourself, who else joins, and their roles | `team.members` |
| 6 | `reviewers`: reviewers | optional | picked from the members | `team.reviewers` |
| 7 | `model`: model credential | required for drafting | `api`: a free models call with the key. `claude-code`: guides you through `claude setup-token`. `bedrock`, `vertex`: prints what the CI identity needs | a secured CI variable; `agents.runtime` |
| 8 | `slack`: Slack | optional | one test post to the webhook, which you confirm arrived; then the reviewers' Slack member IDs | a secured CI variable; `notifications.slackWebhookEnv`; members' `slack` |
| 9 | `schedules`: schedules | required for anything to run on its own | Bitbucket: Pipelines schedules created or enabled through the API (daily run, weekly deep dive, weekly digest when Slack is set). GitHub: the workflows' crons are in the files, and Actions are on | schedules on the KB repo |
| 10 | `codeowners`: CODEOWNERS and branch protection | optional, recommended | writes CODEOWNERS; reads protection back where the token may, else prints the exact settings to click | `.bitbucket/CODEOWNERS` or `CODEOWNERS` |
| 11 | `commit`: commit and push | required | `validate` passes; one commit, `homeostat: setup`, on the branch `homeostat-setup` for review, or on `main` if you say so (an empty repo's first commit goes to `main`) | |
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

## Secrets

- **Hidden.** Each secret is read from the terminal without echo. It is never printed, logged or written to a file. Every line setup prints is scrubbed of the secrets typed in that run.
- **Cleaned.** Surrounding whitespace and line breaks are trimmed. A value with spaces or line breaks inside, or the same value pasted twice, is refused, and you are asked again. Those were the most common ways a token pasted by hand went wrong.
- **Verified before it is stored.** The git-host token reads the KB repo, a code repo's PRs and the members. The API key lists one model. The webhook gets one test post. A Bitbucket token is tried as an Atlassian API token (Basic, with its account email) and, when that is refused, as an access token (Bearer); setup tells you which it was.
- **Stored where CI reads it.**
  - Bitbucket: secured repository variables on the KB repo, through the Pipelines variables API, created or updated by name. That write needs admin access to the KB repo (`admin:pipeline:bitbucket`), which the CI token usually lacks. Setup asks whether to use it anyway or a separate token for these writes only, which is kept in memory for the run.
  - GitHub: Actions secrets, with `gh secret set NAME -R owner/repo` and the value on standard input, when `gh` is installed and logged in. Otherwise setup prints that exact command to run yourself. The REST API needs secrets encrypted with libsodium first, a dependency Homeostat doesn't take.
- **If a write is refused**, setup prints where to paste the value by hand (the repository variables page, or the Actions secrets page) and the variable's name. It never prints the value.
- `--check` reports only whether each variable exists, never its value.

The variable names are the ones the CI files read: `HOMEOSTAT_BITBUCKET_TOKEN` and `HOMEOSTAT_BITBUCKET_EMAIL`, `HOMEOSTAT_GITHUB_TOKEN`, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and `HOMEOSTAT_SLACK_WEBHOOK`.

## Teammates: `setup --join`

Each developer runs this once, in their clone of the KB:

```sh
npx --yes homeostat@0.3.2 setup --join
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
- Reads a code repo's contents beyond its top-level folder names (for areas), and the files `bootstrap` previews.
- Regenerates your `homeostat.yaml`. Every change is an in-place edit, so your comments and ordering survive.

## In the dashboard

The Overview page of `homeostat dashboard` has a Setup card. It shows a bar of the required steps done, and the checklist, with the `homeostat setup --step` command that fixes each missing step. The dashboard makes no network calls and holds no tokens, so it shows two kinds of row:

- Steps it can decide from the files: the config, CODEOWNERS, the CI files, documents.
- Steps only the git host can confirm: the token and the model credential being stored, the schedules, the webhook. For these it shows the last result that `homeostat setup` or `setup --check` recorded on this machine, with its date. The record is `.homeostat/setup.json`, which git ignores; it holds each step's state, when it was checked and a short reason, never a secret.

A last line shows this laptop's `setup --join` result. Until every required step is done, the card leads the page. The shared build (`homeostat dashboard --build`) shows only the rows the files decide, since the record stays on each laptop.
