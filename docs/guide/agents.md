# The agents

Homeostat's agents run in your KB repo's CI (or on one shared box with `homeostat up`), never on developers' laptops. They read the git host, call a model through the runtime you choose, and write only to the KB repo, always by pull request.

## Daily run {#daily}

`homeostat daily` is the one scheduled job. It reads only what is already on the git host, so developers' laptops can be closed. For each developer it:

1. **Collects** their pending lessons, which their sessions pushed to `candidates/<member>`, and drafts lessons from review comments on their own merged PRs (below).
2. **Scores** each lesson for confidence, 0–100: its source, the role of whoever vouches for it (junior less, senior and lead more), whether it is specific, and its flags and conflicts.
3. **Decides** each one: merge at 70 or above (80 for `core`), decline below 35 or as a duplicate, and a reviewer for anything in between. A new lesson that only refines a rule the KB already has becomes an **update** of that rule instead ([below](#consolidate)). Risky content, conflicts, document patches and areas outside `scoring.autoMerge` always go to a reviewer. A rule drafted from a review that would merge with nobody reading it is first checked by a second model against its thread ([the judge](#judge)).
4. **Opens one daily PR** with the merged lessons, each decision explained in the body, and merges it. Its commits are marked `[skip ci]`, since the branch is gone before a pipeline could start; the merge commit on the base branch is not, so the base branch is still validated.
5. **Opens one review PR** for the middle band, after every developer's daily PR has merged, so it starts level with the base branch, and requests the area's owners as reviewers (on Bitbucket the token needs `read:workspace` to find them by nickname). Merging it accepts them; closing it declines them. Reviewers can do that on the host, or with `homeostat review` (`list`, `show`, `merge`, `close --reason`), which works the same on GitHub and Bitbucket and is what `/homeostat:review` uses.
6. **Opens one dispute PR per flagged rule.** A flag takes the rule out of sessions at once; the PR proposes a fix drafted from the flags (a renamed helper, a moved file), keeping the parts nobody disputed. Merging puts it back in force; closing retires the rule, and the next run takes its claims out of the documents that cite it ([retractions](#retract)).
7. **Records** the decisions on the `homeostat/state` branch. Developers' sessions pick them up and tell them, and the dashboard's Automation page shows them.

`--dry-run` prints every decision, including each update-or-add answer, each judge verdict and each retraction, and writes nothing. `--no-reviews` skips the model and decides pending lessons only; dispute PRs then propose retiring the rule, nothing is judged, and sections citing a retired rule are listed instead of rewritten. Weights and thresholds: `scoring.confidence` ([config](config.md)). If Slack is set up, the run posts the review queue each morning and repeats lessons waiting more than 2 days.

Protect the base branch and let only the daily run's token bypass it (`init` prints how). If the host refuses the merge, the daily PR stays open for a reviewer, with a commit that lets its pipeline run.

In a KB with topic files, review PRs that share a file conflict once one of them merges. `homeostat review merge` rebuilds such a PR on the base branch, adding its rules beside the ones already there (and, in documents, combining additions to the same section), waits until the host shows the rebuilt commit (nudging Bitbucket, which can miss a force push, with an ordinary one), and merges it.

### Lessons from reviews

The daily run reads pull requests merged in the KB's code repos (`repos`, or `sources.repos` in a KB without repo folders) since its last run (`homeostat curate` does the same on its own). For each review thread that:
- was written by a team member
- was followed by a code change
- is not already in the KB

it does three things (threads whose lesson is still waiting in an open review PR are skipped, so a lesson is not drafted twice):

1. **Redacts secrets** from the thread, then asks the model whether it holds a lasting rule, and drafts one, with its area and its topic from the repo's list. The lesson is filed under the repo the PR came from. When no topic fits, it goes to `general` with a suggested topic, listed in the PR for you to add to `homeostat.yaml` if it is worth one.
2. **Checks documents.** If a team document covers the file, it asks whether the thread makes one of its sections out of date, and proposes a one-section patch.
3. **Validates the draft**, including the secret and risky-content checks.

It never reads source code. It skips PRs marked `homeostat:skip`, members with `optOut`, and anything in `sources.exclude`. `homeostat curate --show-prompts` prints every prompt and sends nothing.

### Update before add {#consolidate}

The same lesson often comes back in other words ("Parse DB URLs by last '@'" and, a week later, "Parse the DATABASE_URL by last '@', not urlsplit"). Before adding a new lesson, the daily run:

1. **Finds candidates without a model:** the up to three rules (in force in the same repo or core, or waiting in an open review PR) whose words or code overlap the lesson's most. Code that many rules name counts for less. Two rules are never candidates when each has a number or version the other lacks (v1 and v2, 101 and 102), or they name look-alike code (`useFoo` and `useFooBar`).
2. **Asks the model once**, only for a lesson with candidates, with secrets redacted: `update` a rule (the whole rule rewritten to keep everything still true and add the new detail, with a reason), `duplicate` (nothing new), or `create`. It must answer create when a number, negation, named entity or condition differs, and never folds in a contradiction.
3. **Applies the answer.** An update changes the rule in place (its section in a topic file): same id, owner and first source, the new title and text, confirmed today, and the lesson's review link added under `alsoFrom` so the thread is not drafted again. It is scored like any lesson, on the lesson's own source and author, and lands in the daily PR, shown as `Update:` with the reason, or in the review PR. A duplicate is declined and reconfirms the rule. A contradiction goes to a reviewer.

At most `agents.curator.consolidateCalls` (30) calls per run, each a few thousand characters; past that, on a model error, or with `--no-reviews`, the older word-overlap duplicate check decides. Every call is logged as a `model-call` event.

### The judge {#judge}

A confident lesson merges with nobody reading it. Its confidence says the lesson is genuine (a member's comment led to a code change), not that the drafted rule says only what the comment said, and a drafting model can add things: a value the reviewer never gave, a helper name, a wider scope, "always" where the comment said "maybe here". Every agent then treats those as fact.

So before a rule drafted from a review merges without a person, the daily run asks a second model to check it against the redacted thread (and, for an [update](#consolidate), the rule it rewrites). The judge answers `{ok, problems: [{trap, evidence}]}` for four traps:

| Trap | The rule |
| --- | --- |
| `invented-detail` | states a value, name, path, number or reason the thread does not give |
| `wider-scope` | applies to more than the comment addressed |
| `overgeneralised` | turns a one-off or conditional suggestion into "always" or "never" |
| `contradicts-thread` | says the opposite of what the thread asked or concluded |

A pass costs one call. A failure is asked twice more and kept only when most of the three answers fail the rule, so one noisy answer neither blocks nor passes it (the pattern is adapted from [Hindsight](https://github.com/vectorize-io/hindsight)'s eval judge, MIT, where a trap is the side that gets re-asked). Current models take no temperature setting, so the re-asks vary by the model's own sampling.

- **A kept failure** loses `scoring.confidence.penalty.judge` (30) points and goes to the review PR, whose body lists each problem with the judge's evidence.
- **A kept contradiction** (most answers name `contradicts-thread`) is declined: the rule teaches the opposite of its own evidence, a reviewer would have to rewrite it from the thread anyway, and the decline and the evidence are in the daily PR for anyone who wants to write it by hand.
- **Unjudged is not passed:** a judge that errors or gives no usable answer, and drafts past `agents.curator.judgeCalls` (100 calls; keep it above the lessons a busy day merges on its own), go to a reviewer. `judgeCalls: 0` turns the judge off, and drafts merge on confidence alone as before.

Only these lessons are judged: the middle band already goes to a person, and lessons written by hand have no thread to hold them to. The judge's model is `agents.curator.judgeModel`; by default `claude-sonnet-5-5` under an Opus drafter and `claude-haiku-4-5-20251001` under a Sonnet one (never a dearer model than the drafter: it runs up to `judgeCalls` times a day), on the same runtime as the drafter (with `claude-code` the model is passed to `claude --model`). The run warns when you set it to the drafter's own model. Each call is a few thousand characters and is logged as a `model-call` event with agent `judge`.

### Retractions {#retract}

A retired rule stops reaching sessions, but a document section written from it keeps saying it. When a run retires a rule, it looks for the sections that cite it:

- **by id**: the rule's id in the section's text, as a whole word (a one-word id only in a credit form such as `(id)` or `` `id` ``), or
- **by provenance**: the section's `url` is the rule's review thread (or one folded into it).

It never matches on words alone: a section that talks about the same thing may rest on other evidence, and deleting something still true is worse than leaving something stale (the approach is adapted from Hindsight's retractions, MIT). For each citing section it asks the model, secrets redacted, for the section's text with only what rested on the retired rule taken out; the rules in force that the section also cites are sent as still supported. If nothing rests on it, there is no patch, only a line in the output. A rewrite is kept only when it applies as a one-section patch, validates, no longer cites the rule, adds nothing (at most a joining word or two) and leaves text behind; its provenance becomes `source=curator` (or `deep-dive`) with `note="retracted <id>"`, keeping the old `url` unless it was the retired rule's thread. Anything else is listed for a person.

- **Daily run** (a dispute PR closed): the retirement merges in the daily PR as before, since a reviewer decided it; the document patches go in the same run's review PR, because documents never merge on their own. At most `agents.curator.retractCalls` (10) calls.
- **Deep dive** (a rule retired as stale): the patches go in the deep-dive PR with the retirement. At most `agents.deepDive.retractCalls` (10). A rule merged into another as a duplicate is not retracted (the survivor says the same); its citations are listed so the id can be updated.

### On developers' machines

Nothing is scheduled there. The Claude Code plugin's hooks run `homeostat sync` in the background: when a session starts, on a prompt at most every 3 hours (sessions often stay open for days), and when a session stops with new lessons. A sync pulls the team KB, clears lessons the daily run has decided, and pushes new ones. Its fetches and push give up after 2 minutes (`HOMEOSTAT_GIT_TIMEOUT_MS`), and over ssh within about 20 seconds of a dead connection, so a sleeping laptop or a dropped network never leaves one hanging. `homeostat learn` lessons apply to the author's own sessions at once and reach the team the next morning.

## Deep dive (weekly)

`homeostat deep-dive`:
- merges near-duplicate rules into the stronger one (fewer now that the daily run updates rules instead of adding siblings; pairs with different numbers or look-alike code names are never merged)
- asks the model whether this week's rules contradict older ones, and marks them
- retires rules nobody has confirmed in `staleAfterDays`, and rewrites the document sections that cite them without the retired claims ([retractions](#retract))
- notes document coverage gaps and stale sections

Its changes go in one PR, which a person merges. `--no-llm` skips the model; sections citing a retired rule are then listed in the PR instead.

## Bootstrap and seed (by hand only) {#seed}

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
| GitHub Actions | `init` writes `homeostat-curator.yml` (the daily run; the name is kept from 0.1), `homeostat-deep-dive.yml` and `homeostat-digest.yml`. The token is the Actions secret `HOMEOSTAT_GIT_TOKEN` (the old `HOMEOSTAT_GITHUB_TOKEN` still works), else the workflow's own `GITHUB_TOKEN`, which reaches the KB repo only |
| Bitbucket Pipelines | `init` writes custom pipelines (`homeostat-curator` runs the daily run, a name kept from 0.1 so existing schedules keep working); schedule them under Repository settings → Pipelines → Schedules. The token is the secured variable `HOMEOSTAT_GIT_TOKEN`: an access token, or an Atlassian API token with the email of the account that created it in `HOMEOSTAT_GIT_EMAIL` ([which token](setup.md#git-host-token)). The names up to 0.3.2, `HOMEOSTAT_BITBUCKET_TOKEN` and `HOMEOSTAT_BITBUCKET_EMAIL`, still work |
| One shared box | `homeostat up` runs the daily run and the deep dive on their cron schedules and the digest on `digestDay`, and serves the dashboard. The Docker image does the same |

`homeostat setup` stores the tokens as CI variables and, on Bitbucket, creates the schedules through the Pipelines API; `homeostat setup --check` says what is still missing ([setup](setup.md)). Check a setup's security with `homeostat doctor --security`.
