# Configuration: `homeostat.yaml`

One file at the KB root. `homeostat validate` checks it, and the dashboard's Settings pages edit every key. Only `version`, `team` and `areas` are required; everything else has a default.

## `version`, `team`, `teams`, `areas`

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | (required) | Always `1` |
| `team.members` | (required) | Each member has an `id` (lowercase), `role` (`senior` or `member`), and `areas` they review. Optional: `handle` (`@user`, `@org/team` or an email, used for CODEOWNERS and to recognise reviewers on the git host), and `optOut: true` (the curator never reads their PRs or review comments) |
| `teams` | `{}` | Team name → `handle` (`@org/team`), `members`, `areas` it owns, and `repos` it works in. The owning team approves its areas' rules and documents. Every session still reads every team's rules for the files it touches |
| `areas` | (required) | Area name → path globs in your code repos. `core` is implicit and applies everywhere |

## `scoring`

| Key | Default | Meaning |
| --- | --- | --- |
| `scoring.weights.prFeedbackChangedCode` | `3` | Review feedback followed by a code change |
| `scoring.weights.prFeedback` | `0` | Review feedback with no code change after it |
| `scoring.weights.manual` | `2` | Written by a member by hand |
| `scoring.weights.agentHandoff` | `0` | Written by an agent at the end of a session |
| `scoring.weights.deepDive` | `0` | Produced by the deep dive (merges) |
| `scoring.weights.seniorAuthor` | `1` | Bonus when a senior wrote it |
| `scoring.weights.conflict` | `-2` | Per conflict with another rule |
| `scoring.weights.flag` | `-2` | Per open flag |
| `scoring.autoMergeThreshold` | `3` | Score at which a curator rule may merge without a reviewer, if it passes every [gate](agents.md#auto-merge) |
| `scoring.autoMerge.enabled` | `true` | Turn auto-merge off entirely |
| `scoring.autoMerge.areas` | `[]` | Areas that may auto-merge; empty means all |
| `scoring.autoMerge.excludeAreas` | `[]` | Areas that always need a reviewer, e.g. `core` |
| `scoring.autoMerge.maxPerRun` | `5` | Most entries one curator run may auto-merge |
| `scoring.reviewCadence` | `weekly` | Reserved for review reminders; not used yet |

## `agents`

| Key | Default | Meaning |
| --- | --- | --- |
| `agents.runtime` | `api` | How the curator and deep dive reach Claude: `api` (a Console key), `bedrock`, `vertex`, or `claude-code`. See [runtimes](../runtimes.md) |
| `agents.bedrock.region` | `AWS_REGION` | AWS region for `runtime: bedrock` |
| `agents.vertex.projectId` | `ANTHROPIC_VERTEX_PROJECT_ID` | Google Cloud project for `runtime: vertex` |
| `agents.vertex.region` | `global` | `global`, `us`, `eu` or a region |
| `agents.curator.enabled` | `true` | Run the curator under `homeostat up` |
| `agents.curator.schedule` | `0 6 * * *` | Cron (UTC) for `homeostat up`; CI uses its own schedule |
| `agents.curator.model` | `claude-opus-5-5` | Any model id the runtime accepts |
| `agents.curator.effort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `agents.curator.lookbackHours` | `26` | How far back each run reads merged PRs |
| `agents.deepDive.enabled` | `true` | Run the deep dive under `homeostat up` |
| `agents.deepDive.schedule` | `0 7 * * 1` | Cron (UTC) |
| `agents.deepDive.model` | `claude-opus-5-5` | |
| `agents.deepDive.effort` | `medium` | |
| `agents.deepDive.lookbackHours` | `168` | Which rules count as "this week's" for the contradiction check |
| `agents.deepDive.staleAfterDays` | `180` | Accepted rules not confirmed for this long are retired; older document sections are flagged |
| `agents.handoff.enabled` | `true` | Ask for a handoff note at the end of sessions with real edits |
| `agents.handoff.minEdits` | `5` | File edits before the note is asked for |

## `distribution`

| Key | Default | Meaning |
| --- | --- | --- |
| `distribution.exports` | all four | Which tools `homeostat export` writes for: `claude`, `cursor`, `agents-md`, `copilot` |
| `distribution.tokenBudget` | `2000` | Tokens of rules per session |
| `distribution.docTokenBudget` | `1000` | Tokens of document index and sections per session, on top of the rules |

## `notifications`

| Key | Default | Meaning |
| --- | --- | --- |
| `notifications.slackWebhookEnv` | (none) | Name of the environment variable or CI secret holding the Slack webhook URL for the [digest](agents.md#digest). Never the URL itself |
| `notifications.digestDay` | `monday` | Day `homeostat up` posts the digest (08:00 UTC); CI uses its own schedule |

## `security`

| Key | Default | Meaning |
| --- | --- | --- |
| `security.allowedDomains` | `[]` | Domains rules may link to (subdomains included). The git host is always allowed |
| `security.eventRetentionDays` | `90` | Days the local event log keeps events |
| `security.teamOnlyAreas` | `[]` | Areas never exported, and seen only by their members' sessions |
| `security.mcpWrites` | `false` | Let agents save and flag rules through MCP |
| `security.mcpWriteLimit` | `5` | With MCP writes on: the most writes per session |

## `sources`

Needed by the curator, not by validation.

| Key | Default | Meaning |
| --- | --- | --- |
| `sources.host` | (required) | `github` or `bitbucket` |
| `sources.kbRepo` | (required) | `owner/name` of this KB repo: the only repo the agents write to |
| `sources.baseBranch` | `main` | Where the agents open pull requests |
| `sources.repos` | `[]` | Code repos whose merged PRs the curator reads |
| `sources.exclude.repos` | `[]` | Repos never read |
| `sources.exclude.paths` | `[]` | Globs: review comments on these files are never read or sent |
