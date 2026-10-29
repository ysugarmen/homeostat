# Data handling

What Homeostat reads, what leaves your network, where it goes, what it keeps, and how to turn each part off. For the threat model behind it, see [security.md](security.md); to check a real setup, run `homeostat doctor --security`.

## No service in between

Homeostat is software you run, not a service you send data to. There is no Homeostat server, account or telemetry, and nobody but you operates any part of it:

| Part | Runs on | With whose credentials |
| --- | --- | --- |
| The knowledge base | Your git host (GitHub or Bitbucket), in a repo you own | Your team's access rules |
| Daily run, deep dive, digest | Your KB repo's CI, or `homeostat up` on a box of yours | A git-host token and a model credential stored as your CI secrets |
| Session hooks, MCP server, dashboard | Each developer's machine, inside their Claude Code, on a local clone | The developer's own git credentials |
| Model calls | The provider you choose: Anthropic's API, Amazon Bedrock, Google Vertex AI, or a Claude Code login | Your key, your cloud account, or your login |

What follows from that:
- **The only places your data goes** are your git host, your model provider and, if you configure it, your Slack webhook. The code makes no other network calls.
- **The agreements that apply** are the ones you already have with those providers: your git host's terms, and your model provider's data and retention terms (for Bedrock and Vertex, your own cloud account's). There is no third party in between to review.
- **Deleting the KB repo removes everything Homeostat stored,** apart from what lives with those providers under their terms (CI logs, model-provider retention) and each machine's local `.homeostat/` folder (the event log and handoff state), which deletes with the clone.
- **Cost and limits are yours to see:** each run prints its calls, tokens and cost, and `agents.maxCostUsd` caps it. A Claude Code login spends that person's own usage limits.

## What it reads

| Part | Runs | Reads | Never reads |
| --- | --- | --- | --- |
| Daily run | Your KB repo's CI, daily | Merged PRs in the KB's code repos (`repos`, or `sources.repos`): titles, review comments, the file and line they are on, and commit dates (to see whether code changed after a comment) | Source code, diffs, issues, CI logs. PR descriptions are only checked for the `homeostat:skip` marker, never sent anywhere |
| Deep dive | Your KB repo's CI, weekly | The KB's own entries and documents | Anything outside the KB repo |
| `seed` and `bootstrap` (by hand only) | One person's terminal, when they run it | Local checkouts: the file tree, key files (README, manifests, build files), schema and migration files, deploy manifests and pipelines, minus `sources.exclude.paths`, with secrets redacted. `bootstrap` also copies the repo's existing Markdown docs, without a model | Terraform state, `.env` files, keys, Secret manifests, files full of credentials, tests; no database, cloud or cluster connections; it never runs on a schedule |
| Session hooks, MCP server | Each developer's machine | KB files, and the paths of files changed in the current repo (`git status`, recent commits). The Stop hook also reads the session's transcript file, on the machine, to count edits and, per user turn, the Homeostat tools called and the `> From Homeostat (…)` credit lines | File contents. Prompt and reply text is read in memory to find those lines and is never stored or sent |
| Export | Laptop or CI | KB files | Anything else |
| Dashboard | Loopback on one machine | KB files, the local event log and the local setup record | Anything else |
| `setup` (by hand only) | One person's terminal, when they run it | The KB checkout. On the git host: the KB repo's and code repos' metadata, one PR per code repo (to check access), workspace or org members, top-level folder names, CI variable names (never values) and Pipelines schedules | Code repo contents beyond top-level folder names |

## What leaves your network, and where to

- **Review threads, to the model.** Only the daily run (and `curate`, which runs its drafting on its own), the deep dive and `migrate --topics` call a model; `migrate --topics` sends rule titles and text, once. They send a review thread (comment text, PR title, file path and line, area names) or entry text. The daily run also sends a new lesson together with the (at most three) existing rules most like it, title, scope, rule and why, to decide whether it updates, repeats or adds to them; at most `agents.curator.consolidateCalls` such calls per run. Before a drafted rule merges with no person, the daily run sends the same redacted thread again with the drafted rule (title, rule, why, the paths it applies to, and for an update the rule it rewrites) to the judge model, `agents.curator.judgeModel`, on the same runtime: one call for a pass, three for a failure, at most `agents.curator.judgeCalls` per run. When a run retires a rule (the daily run, after a dispute PR is closed; the deep dive, for stale rules), it sends each document section that cites that rule, with the retired rule's title, rule and why and the titles and rules of any rules in force the section also cites, to rewrite it without the retired claims: at most `agents.curator.retractCalls` or `agents.deepDive.retractCalls` sections per run. Secrets are redacted first. Where it goes depends on `agents.runtime`: Anthropic's API, your own AWS (Bedrock) or Google Cloud (Vertex) account, or Claude Code's login. See [runtimes.md](runtimes.md).
- **Code, only when someone runs `homeostat seed` or `homeostat bootstrap`.** They send selected files from local checkouts to draft first documents. `--dry-run` lists every file (and `--prompts` prints exactly what would be sent) and sends nothing; a real `bootstrap` asks before the first call. Nothing schedules them.
- **API calls, to your git host.** These read PRs, and open and merge pull requests on the KB repo only. `export` and `doctor` also make one unauthenticated call to check whether a repo is public.
- **Tokens, only to verify them, when someone runs `homeostat setup`.** Setup sends each secret only to the service it belongs to:
  - the git-host token to your git host, to read the KB repo, a code repo's PRs and the members, and to store it as a CI variable
  - the Claude API key to Anthropic, in one free models call
  - the Slack webhook to Slack, in one test post

  A GitHub secret is passed to `gh` on standard input. Nothing else is sent, and no secret is written to disk.
- **Nothing else.** There is no telemetry and no Homeostat service. The hooks and MCP server make no network calls of their own. A background `homeostat sync`, started by the session hooks, fetches the KB repo and pushes your pending lessons plus a small heartbeat (your member id, KB commit, pending count, Homeostat version, and, only if you set `usage: true` on your member or `HOMEOSTAT_SHARE_USAGE=1`, per-day counts of your sessions, injections, rules served, MCP calls, document reads, and turns, turns that looked something up and turns that credited it, for the last seven days: never rule ids, paths or times finer than a day) to your `candidates/<member>` branch on the KB repo's origin, with your own git credentials. The dashboard shows teammates' heartbeats as sync health.

## What it stores

- **The KB repo**: entries, as reviewed pull requests. An entry keeps a link to the review comment and member ids, never quotes or emails. Secrets fail validation, so they cannot be merged.
- **`.homeostat/events.db` on each machine**: rule ids injected per session, tool calls, agent runs, model-call sizes, and how long each session start, MCP call and sync took, never content. A `turn-usage` event per user turn holds the session id, the turn number and when it began, the Homeostat tool names called, whether one retrieved, whether the reply credited, and the credited rule and section ids that exist in the KB (anything else is only counted). Never prompt or reply text. It is git-ignored, never uploaded, and pruned after `security.eventRetentionDays` (90).
- **Your clone's `.homeostat/pending/`** (git-ignored): lessons you saved that the daily run has not decided yet. They are also on your `candidates/<member>` branch until decided.
- **The `homeostat/state` branch** of the KB repo: each daily run's decisions per lesson (id, content hash, decision, confidence, reason, PR branch, when it was opened and settled), developers' heartbeats, and a run report with the run's own timing, model-call counts and the KB's health counts. No lesson text.
- **Usage counts in your heartbeat**, only when you opt in (`usage: true` on your member, or `HOMEOSTAT_SHARE_USAGE=1`): seven days of per-day counts, for the team's Performance page. Nothing named.
- **Your CI secrets**: the git-host token and the model credential. They never appear in files, prompts or logs. `homeostat setup` stores them as CI variables (Bitbucket) or Actions secrets (GitHub), and nowhere else.
- **`.homeostat/setup.json` on the machine that ran `setup`** (ignored by git): each step's last state (done, missing, broken), when it was checked and a short reason, for the dashboard. Never a secret or a token value.

## How to turn each part off

| To stop | Do this |
| --- | --- |
| Reading one repo | Remove it from `repos` (or `sources.repos`), or add it to `sources.exclude.repos` |
| Reading comments on sensitive files | Add globs to `sources.exclude.paths` |
| Reading one pull request | Mark it `homeostat:skip` (a GitHub label, or in the title or description) |
| Reading one person's PRs and comments | Set `optOut: true` on that member |
| Sending anything to a model | Disable `agents.curator` (the daily run's drafting) and `agents.deepDive`, run `daily --no-reviews` and `deep-dive --no-llm`; don't run `seed`, `bootstrap` or `migrate --topics` |
| Sending code to a model | Don't run `seed` or `bootstrap` (nothing else sends code) |
| Syncing from a laptop | Set `HOMEOSTAT_NO_SYNC=1` in the environment; your lessons then reach the team only when you run `homeostat sync` yourself |
| Seeing what would be sent | `homeostat curate --show-prompts` for review threads, `bootstrap --dry-run --prompts` for code (both send nothing) |
| Entries merging without review | `scoring.autoMerge.enabled: false`, or `excludeAreas` for some areas |
| Agents saving entries | Leave `security.mcpWrites` off (the default) |
| An area's rules spreading | Add it to `security.teamOnlyAreas`: never exported, and only its members' sessions see it |
| Rules reaching a public repo | `export` refuses unless you pass `--allow-public` |
| Rules reaching sessions at all | Uninstall the plugin, or unset its `kb_dir` |
| The local event log | Delete `.homeostat/`; lower `security.eventRetentionDays` |
| Per-turn usage from the transcript | Set `HOMEOSTAT_NO_TURN_USAGE=1` in the environment (the Stop hook then reads the transcript only to count edits for handoff notes) |
| Sharing usage counts | Leave `usage` unset on your member and `HOMEOSTAT_SHARE_USAGE` unset (the default) |
