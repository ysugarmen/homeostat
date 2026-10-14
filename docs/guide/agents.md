# The agents

Homeostat's agents run in your KB repo's CI (or on one shared box with `homeostat up`), never on developers' laptops. They read the git host, call a model through the runtime you choose, and write only to the KB repo, always by pull request.

## Curator (daily)

`homeostat curate` reads pull requests merged in `sources.repos` since its last run. For each review thread that:
- was written by a team member
- was followed by a code change
- is not already in the KB

it does three things:

1. **Redacts secrets** from the thread, then asks the model whether it holds a lasting rule, and drafts one.
2. **Checks documents.** If a team document covers the file, it asks whether the thread makes one of its sections out of date, and proposes a one-section patch.
3. **Validates the draft**, including the secret and risky-content checks, and opens pull requests.

It never reads source code. It skips PRs marked `homeostat:skip`, members with `optOut`, and anything in `sources.exclude`. `--show-prompts` prints every prompt and sends nothing.

### Auto-merge

A drafted rule merges with no reviewer only if **all** of these hold:

- its score reaches `scoring.autoMergeThreshold`
- it is review feedback from a team member, followed by a code change (never agent-written, never a deep-dive edit)
- it has no flags and no risky-content findings
- its area is in `scoring.autoMerge` scope, and the run has not hit `maxPerRun`

Auto-merged rules go in their own PR titled "auto-merge". The curator validates the whole KB before merging, and anyone can `homeostat flag <id>` to send a rule back to review. Everything else, including every document patch, goes to a review PR for the owning team. Protect the base branch and let only the curator's token bypass it (`init` prints how).

## Deep dive (weekly)

`homeostat deep-dive`:
- merges near-duplicate rules into the stronger one
- asks the model whether this week's rules contradict older ones, and marks them
- retires rules nobody has confirmed in `staleAfterDays`
- notes document coverage gaps and stale sections

Its changes go in one PR. `--no-llm` skips the model.

## Seed (by hand only) {#seed}

`homeostat seed <checkout> --area <area> --owner <member>` drafts a new team's first documents (`architecture`, `conventions`, `cross-repo`) from a scan of one local repository. It sends the file tree and a few key files (README, manifests, build files), with `sources.exclude.paths` applied and secrets redacted. This is the only command that sends code to a model, so nothing schedules it. `--dry-run` prints everything it would send. Each document arrives as its own PR, every section marked `source=seed` with the model's confidence.

## Digest (weekly) {#digest}

`homeostat digest` posts a Slack message to the webhook named by `notifications.slackWebhookEnv`. It lists:
- new and reconfirmed rules, and decisions the team rejected
- updated document sections
- the review queue and this week's flags
- the tool names agents guessed

It is built without a model. `--dry-run` prints it instead.

## Model runtimes

`agents.runtime` decides where prompts go:

| Runtime | Where prompts go |
| --- | --- |
| `api` (default) | Anthropic's API, with a Console key |
| `bedrock` | Claude in Amazon Bedrock, in your AWS account |
| `vertex` | Claude on Google Cloud, in your project |
| `claude-code` | A Claude Code login; for personal use or Team/Enterprise plans |

Each model call is logged locally by size, never content. Details: [runtimes](../runtimes.md).

## Running the agents

| Where | How |
| --- | --- |
| GitHub Actions | `init` writes `homeostat-curator.yml`, `homeostat-deep-dive.yml` and `homeostat-digest.yml` |
| Bitbucket Pipelines | `init` writes custom pipelines; schedule them under Repository settings → Pipelines → Schedules |
| One shared box | `homeostat up` runs the agents on their cron schedules and the digest on `digestDay`, and serves the dashboard. The Docker image does the same |

Check a setup with `homeostat doctor --security`.
