# How a team uses it

A team starting from zero has three roles: an **admin** who sets it up once, **developers** who join once and then work as usual, and **reviewers** who handle a short queue each day. This page follows each of them, then the two things that run on their own: each laptop's sync and the daily run.

## The admin: setup, once (about 20 minutes)

In a new, empty repo for the knowledge base (KB), for example `acme/team-kb`:

```sh
npx homeostat setup
```

It is a checklist: it checks each step with a real call, asks only for what is missing, and can be run again at any time. `setup --check` prints what is done and what is not. Every step is in [Guided setup](setup.md).

| Step | What happens |
| --- | --- |
| Host and KB repo | Detects GitHub or Bitbucket from `origin`, writes `homeostat.yaml`, `knowledge/` and the CI files |
| Git token for CI | Verified, then stored as a secured CI variable. It reads pull requests in the code repos and writes the KB repo |
| Code repos | The repos to learn from, with optional areas per repo (for example `services/billing/**`) |
| Team | Members listed from the workspace or org, each with a role (lead, senior, member) that weighs their reviews in the score |
| Reviewers | Optional: who handles the middle band. Without them, an area's owners, then seniors and leads |
| Model credential | An Anthropic API key, or Amazon Bedrock or Google Vertex AI, stored as a CI variable. Set `agents.maxCostUsd` to cap each run |
| Slack | Optional: a webhook for the daily review-queue message |
| CODEOWNERS and branch protection | Optional, recommended: `main` changes only by pull request |
| Schedules | The daily run (06:00 UTC by default) and the weekly deep dive, as Pipelines schedules or Actions crons |
| First base | Optional: [`bootstrap`](bootstrap.md) drafts documents from each repo's code and existing docs, as one pull request to review |

## Each developer: join, once (about 2 minutes)

```sh
git clone <your team KB repo> ~/team-kb
cd ~/team-kb
npx homeostat setup --join
```

`--join` installs the Claude Code plugin (session hooks and a local MCP server), points it at the clone, and checks that the developer's git identity (the email and name their commits carry) maps to a member in `homeostat.yaml`, by the member's `emails` first. That mapping is how their review comments and lessons are credited and weighted.

Nothing is scheduled on the laptop: no daemon and no cron job.

## A developer's day

They work in their code repos as before. The plugin adds the team's knowledge to their Claude Code sessions ([details](clients.md)):

- **When a session starts:** the rules for the files being changed, the matching document sections, and a short guide to look up the rest, within a token budget.
- **With every message:** rules and sections whose words match the message, once per session, so a question that names no file gets them too.
- **When the agent opens a file:** the rules about that file (a narrow scope that covers it, or a rule that names it), once per file, up to a few hundred tokens, before it plans anything around it. Agents tend to read code first and look rules up later, if at all; this way a reviewer's rule about a file arrives with the file.
- **To teach a lesson:** `/homeostat:learn` or `homeostat learn`. It is saved in the clone's `.homeostat/pending/`, applies to the author's sessions at once, and goes to the team at the next daily run.
- **To dispute a rule:** `homeostat flag <id> --reason "…"`. It leaves sessions at once and goes back to review.

## How each clone stays current

Nobody has to remember `git pull`. The plugin's hooks run `homeostat sync` in the background when a session starts, on a message at most every 3 hours (a session can stay open for days), and when a reply finishes with new lessons not yet sent. One sync:

1. **Fetches** `origin/main`, the daily run's history branch, and the developer's own `candidates/<member>` branch.
2. **Clears decided lessons.** Pending lessons the daily run merged or declined are removed from the clone, and the next session says what happened to each.
3. **Fast-forwards the clone** to `origin/main`, only when it is on `main` with no local edits to tracked files. Otherwise it changes nothing and the session says the clone is behind, and why.
4. **Pushes** the developer's pending lessons and a small heartbeat (version, commits behind, pending count) to their `candidates/<member>` branch. The [dashboard](dashboard.md) shows who is syncing.

Developers never push to `main`: they only need to write their own `candidates/*` branch.

The plugin runs the Homeostat version the KB's CI pins (`homeostat@x.y.z` in the CI file), read from the clone. To upgrade the team, the admin moves that one pin; every laptop runs the new version from its next sync, and nobody updates the plugin by hand.

## The daily run, in the KB repo's CI

1. **Gathers** the pull requests merged in the code repos since the last run, and every developer's `candidates/` branch.
2. **Drafts** one short rule for each review comment that was followed by a code change. Developers' own lessons arrive already written.
3. **Checks against what exists:** whether a lesson is new, repeats a rule, or updates one; and whether it makes a team document out of date.
4. **Judges and scores.** A second model checks each confident draft against its review thread. Every lesson gets a 0–100 confidence score from its source, the reviewer's role, whether it names real code, and any flags or problems.
5. **Decides.** 70 or more goes into one pull request per developer, which **merges itself**; 35–69 goes to a review pull request; below 35, or a duplicate, is declined with a reason.
6. **Records** the decisions on the history branch, posts the review queue to Slack, and prints its calls, tokens and cost.

The weekly deep dive merges duplicates, marks contradictions, and retires rules nobody has confirmed in 180 days. Both are described in [The agents](agents.md).

## Reviewers

Code review itself does not change: it is where the lessons come from. Once a day there is one review pull request per developer with the lessons that scored 35–69 (or, with `scoring.reviewPrs: lesson`, one per lesson). Merge to accept them, edit first, or close to decline.

To change a rule, a reviewer can just say so in a comment on its PR ("generalise this to all logging", "scope it to all Python code", "reword: …"). The next daily run rewrites the rule on the PR's branch as asked, moving it to another area or scope if needed, checks it, and replies on the PR with what changed; the reviewer then merges. Comments from the named reviewers (or, without them, seniors and leads) count, each once; a question or an approval changes nothing. This works on one-lesson PRs; on a PR with several rules, edit the file. `homeostat review merge --all` previews the whole queue and merges it.

## Other tools

A CI job in each code repo can run `homeostat export` to write the same rules as Cursor, Copilot and AGENTS.md files, and any MCP client can query the KB directly ([Using it from your tools](clients.md)).
