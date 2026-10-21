# Data handling

What Homeostat reads, what leaves your network, where it goes, what it keeps, and how to turn each part off. For the threat model behind it, see [security.md](security.md); to check a real setup, run `homeostat doctor --security`.

## What it reads

| Part | Runs | Reads | Never reads |
| --- | --- | --- | --- |
| Daily run | Your KB repo's CI, daily | Merged PRs in the KB's code repos (`repos`, or `sources.repos`): titles, review comments, the file and line they are on, and commit dates (to see whether code changed after a comment) | Source code, diffs, issues, CI logs. PR descriptions are only checked for the `homeostat:skip` marker, never sent anywhere |
| Deep dive | Your KB repo's CI, weekly | The KB's own entries | Anything outside the KB repo |
| `seed` and `bootstrap` (by hand only) | One person's terminal, when they run it | Local checkouts: the file tree, key files (README, manifests, build files), schema and migration files, deploy manifests and pipelines, minus `sources.exclude.paths`, with secrets redacted. `bootstrap` also copies the repo's existing Markdown docs, without a model | Terraform state, `.env` files, keys, Secret manifests, files full of credentials, tests; no database, cloud or cluster connections; it never runs on a schedule |
| Session hooks, MCP server | Each developer's machine | KB files, and the paths of files changed in the current repo (`git status`, recent commits) | File contents, the conversation |
| Export | Laptop or CI | KB files | Anything else |
| Dashboard | Loopback on one machine | KB files and the local event log | Anything else |

## What leaves your network, and where to

- **Review threads, to the model.** Only the daily run (and `curate`, which runs its drafting on its own), the deep dive and `migrate --topics` call a model; `migrate --topics` sends rule titles and text, once. They send a review thread (comment text, PR title, file path and line, area names) or entry text. Secrets are redacted first. Where it goes depends on `agents.runtime`: Anthropic's API, your own AWS (Bedrock) or Google Cloud (Vertex) account, or Claude Code's login. See [runtimes.md](runtimes.md).
- **Code, only when someone runs `homeostat seed` or `homeostat bootstrap`.** They send selected files from local checkouts to draft first documents. `--dry-run` lists every file (and `--prompts` prints exactly what would be sent) and sends nothing; a real `bootstrap` asks before the first call. Nothing schedules them.
- **API calls, to your git host.** These read PRs, and open and merge pull requests on the KB repo only. `export` and `doctor` also make one unauthenticated call to check whether a repo is public.
- **Nothing else.** There is no telemetry and no Homeostat service. The hooks and MCP server make no network calls of their own. A background `homeostat sync`, started by the session hooks, fetches the KB repo and pushes your pending lessons plus a small heartbeat (your member id, KB commit, pending count, Homeostat version, and, only if you set `usage: true` on your member or `HOMEOSTAT_SHARE_USAGE=1`, per-day counts of your sessions, injections, rules served, MCP calls and document reads for the last seven days: never rule ids, paths or times finer than a day) to your `candidates/<member>` branch on the KB repo's origin, with your own git credentials. The dashboard shows teammates' heartbeats as sync health.

## What it stores

- **The KB repo**: entries, as reviewed pull requests. An entry keeps a link to the review comment and member ids, never quotes or emails. Secrets fail validation, so they cannot be merged.
- **`.homeostat/events.db` on each machine**: rule ids injected per session, tool calls, agent runs, model-call sizes, and how long each session start, MCP call and sync took, never content. It is git-ignored, never uploaded, and pruned after `security.eventRetentionDays` (90).
- **Your clone's `.homeostat/pending/`** (git-ignored): lessons you saved that the daily run has not decided yet. They are also on your `candidates/<member>` branch until decided.
- **The `homeostat/state` branch** of the KB repo: each daily run's decisions per lesson (id, content hash, decision, confidence, reason, PR branch, when it was opened and settled), developers' heartbeats, and a run report with the run's own timing, model-call counts and the KB's health counts. No lesson text.
- **Usage counts in your heartbeat**, only when you opt in (`usage: true` on your member, or `HOMEOSTAT_SHARE_USAGE=1`): seven days of per-day counts, for the team's Performance page. Nothing named.
- **Your CI secrets**: the git-host token and the model credential. They never appear in files, prompts or logs.

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
| Sharing usage counts | Leave `usage` unset on your member and `HOMEOSTAT_SHARE_USAGE` unset (the default) |
