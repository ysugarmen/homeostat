# Data handling

What Homeostat reads, what leaves your network, where it goes, what it keeps, and how to turn each part off. For the threat model behind it, see [security.md](security.md); to check a real setup, run `homeostat doctor --security`.

## What it reads

| Part | Runs | Reads | Never reads |
| --- | --- | --- | --- |
| Curator | Your KB repo's CI, daily | Merged PRs in `sources.repos`: titles, review comments, the file and line they are on, and commit dates (to see whether code changed after a comment) | Source code, diffs, issues, CI logs. PR descriptions are only checked for the `homeostat:skip` marker, never sent anywhere |
| Deep dive | Your KB repo's CI, weekly | The KB's own entries | Anything outside the KB repo |
| Session hooks, MCP server | Each developer's machine | KB files, and the paths of files changed in the current repo (`git status`, recent commits) | File contents, the conversation |
| Export | Laptop or CI | KB files | Anything else |
| Dashboard | Loopback on one machine | KB files and the local event log | Anything else |

## What leaves your network, and where to

- **Review threads, to the model.** Only the curator and deep dive call a model. They send a review thread (comment text, PR title, file path and line, area names) or entry text. Secrets are redacted first. Where it goes depends on `agents.runtime`: Anthropic's API, your own AWS (Bedrock) or Google Cloud (Vertex) account, or Claude Code's login. See [runtimes.md](runtimes.md).
- **API calls, to your git host.** These read PRs, and open and merge pull requests on the KB repo only. `export` and `doctor` also make one unauthenticated call to check whether a repo is public.
- **Nothing else.** There is no telemetry and no Homeostat service. The hooks and MCP server make no network calls, except to push a candidate branch with your own git credentials when you save something.

## What it stores

- **The KB repo**: entries, as reviewed pull requests. An entry keeps a link to the review comment and member ids, never quotes or emails. Secrets fail validation, so they cannot be merged.
- **`.homeostat/events.db` on each machine**: rule ids injected per session, tool calls, agent runs, and model-call sizes, never content. It is git-ignored, never uploaded, and pruned after `security.eventRetentionDays` (90).
- **Your CI secrets**: the git-host token and the model credential. They never appear in files, prompts or logs.

## How to turn each part off

| To stop | Do this |
| --- | --- |
| Reading one repo | Remove it from `sources.repos`, or add it to `sources.exclude.repos` |
| Reading comments on sensitive files | Add globs to `sources.exclude.paths` |
| Reading one pull request | Mark it `homeostat:skip` (a GitHub label, or in the title or description) |
| Reading one person's PRs and comments | Set `optOut: true` on that member |
| Sending anything to a model | Disable `agents.curator` and `agents.deepDive`, or run `deep-dive --no-llm` |
| Seeing what would be sent | `homeostat curate --show-prompts` (sends nothing) |
| Entries merging without review | `scoring.autoMerge.enabled: false`, or `excludeAreas` for some areas |
| Agents saving entries | Leave `security.mcpWrites` off (the default) |
| An area's rules spreading | Add it to `security.teamOnlyAreas`: never exported, and only its members' sessions see it |
| Rules reaching a public repo | `export` refuses unless you pass `--allow-public` |
| Rules reaching sessions at all | Uninstall the plugin, or unset its `kb_dir` |
| The local event log | Delete `.homeostat/`; lower `security.eventRetentionDays` |
