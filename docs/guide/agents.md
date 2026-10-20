# The agents

Homeostat's agents run in your KB repo's CI (or on one shared box with `homeostat up`), never on developers' laptops. They read the git host, call a model through the runtime you choose, and write only to the KB repo, always by pull request.

## Daily run {#daily}

`homeostat daily` is the one scheduled job. It reads only what is already on the git host, so developers' laptops can be closed. For each developer it:

1. **Collects** their pending lessons, which their sessions pushed to `candidates/<member>`, and drafts lessons from review comments on their own merged PRs (below).
2. **Scores** each lesson for confidence, 0–100: its source, the role of whoever vouches for it (junior less, senior and lead more), whether it is specific, and its flags and conflicts.
3. **Decides** each one: merge at 70 or above (80 for `core`), decline below 35 or as a duplicate, and a reviewer for anything in between. Risky content, conflicts, document patches and areas outside `scoring.autoMerge` always go to a reviewer.
4. **Opens one daily PR** with the merged lessons, each decision explained in the body, and merges it.
5. **Opens one review PR** for the middle band and requests the area's owners as reviewers (on Bitbucket the token needs `read:workspace` to find them by nickname). Merging it accepts them; closing it declines them. Reviewers can do that on the host, or with `homeostat review` (`list`, `show`, `merge`, `close --reason`), which works the same on GitHub and Bitbucket and is what `/homeostat:review` uses.
6. **Opens one dispute PR per flagged rule.** A flag takes the rule out of sessions at once; the PR proposes a fix drafted from the flags (a renamed helper, a moved file), keeping the parts nobody disputed. Merging puts it back in force; closing retires the rule.
7. **Records** the decisions on the `homeostat/state` branch. Developers' sessions pick them up and tell them, and the dashboard's Automation page shows them.

`--dry-run` prints every decision and writes nothing. `--no-reviews` skips the model and decides pending lessons only; dispute PRs then propose retiring the rule. Weights and thresholds: `scoring.confidence` ([config](config.md)). If Slack is set up, the run posts the review queue each morning and repeats lessons waiting more than 2 days.

Protect the base branch and let only the daily run's token bypass it (`init` prints how). If the host refuses the merge, the daily PR stays open for a reviewer.

### Lessons from reviews

The daily run reads pull requests merged in `sources.repos` since its last run (`homeostat curate` does the same on its own). For each review thread that:
- was written by a team member
- was followed by a code change
- is not already in the KB

it does three things:

1. **Redacts secrets** from the thread, then asks the model whether it holds a lasting rule, and drafts one.
2. **Checks documents.** If a team document covers the file, it asks whether the thread makes one of its sections out of date, and proposes a one-section patch.
3. **Validates the draft**, including the secret and risky-content checks.

It never reads source code. It skips PRs marked `homeostat:skip`, members with `optOut`, and anything in `sources.exclude`. `homeostat curate --show-prompts` prints every prompt and sends nothing.

### On developers' machines

Nothing is scheduled there. The Claude Code plugin's hooks run `homeostat sync` in the background: when a session starts, on a prompt at most every 3 hours (sessions often stay open for days), and when a session stops with new lessons. A sync pulls the team KB, clears lessons the daily run has decided, and pushes new ones. `homeostat learn` lessons apply to the author's own sessions at once and reach the team the next morning.

## Deep dive (weekly)

`homeostat deep-dive`:
- merges near-duplicate rules into the stronger one
- asks the model whether this week's rules contradict older ones, and marks them
- retires rules nobody has confirmed in `staleAfterDays`
- notes document coverage gaps and stale sections

Its changes go in one PR. `--no-llm` skips the model.

## Seed (by hand only) {#seed}

`homeostat seed <checkout> --area <area> --owner <member>` drafts first documents from a scan of one local repository: `architecture`, `conventions` and `cross-repo` from the file tree and key files (README, manifests, build files), `data` from schemas, ORM files and migrations, `infrastructure` from charts, Terraform, manifests and pipelines. Secrets files are never read, `sources.exclude.paths` applies and the rest is redacted. `seed` and [`bootstrap`](bootstrap.md), which runs it for every repo along with importing their existing docs, are the only commands that send code to a model, so nothing schedules them. `--dry-run` prints everything it would send. Each document arrives as its own PR, every section marked `source=seed` with the model's confidence.

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
| GitHub Actions | `init` writes `homeostat-curator.yml` (the daily run), `homeostat-deep-dive.yml` and `homeostat-digest.yml` |
| Bitbucket Pipelines | `init` writes custom pipelines; schedule them under Repository settings → Pipelines → Schedules. The token is the secured variable `HOMEOSTAT_BITBUCKET_TOKEN`: an access token, or an Atlassian API token with its account's email in `HOMEOSTAT_BITBUCKET_EMAIL` |
| One shared box | `homeostat up` runs the daily run and the deep dive on their cron schedules and the digest on `digestDay`, and serves the dashboard. The Docker image does the same |

Check a setup with `homeostat doctor --security`.
