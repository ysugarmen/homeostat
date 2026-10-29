# Configuration: `homeostat.yaml`

One file at the KB root. `homeostat validate` checks it, and the dashboard's Settings pages edit every key. Only `version` and `team` are required; everything else has a default. A KB for one code repo lists its `areas`; a KB for several lists each repo under `repos`, with its own areas.

## `version`, `team`, `teams`, `areas`, `repos`, `topics`

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | (required) | Always `1` |
| `team.members` | (required) | Each member has an `id` (lowercase), `role` (`junior`, `member`, `senior` or `lead`; seniors and leads own the config), and `areas` they review. Optional: `handle` (`@user`, `@org/team` or an email, used for CODEOWNERS and to recognise reviewers on the git host), `slack` (their Slack member ID; the morning review notice mentions named reviewers), `optOut: true` (the daily run never reads their PRs or review comments), and `usage: true` (their sync shares per-day usage counts, sessions, injections, rules served, MCP calls and document reads for the last seven days, in their heartbeat for the Performance page; off by default, and `HOMEOSTAT_SHARE_USAGE=1` on their machine does the same) |
| `team.reviewers` | (unset) | Member ids who decide the lessons the daily run is unsure about. When set, only they are asked to review its PRs and listed in CODEOWNERS; other members' roles only weigh their lessons. Unset, area owners decide, then seniors and leads. Give them a `slack` member ID to be mentioned in the morning notice |
| `teams` | `{}` | Team name → `handle` (`@org/team`), `members`, `areas` it owns, and `repos` it works in. The owning team approves its areas' rules and documents. Every session still reads every team's rules for the files it touches |
| `areas` | `{}` | Area name → path globs in your code repo, for a KB without repo folders. `core` is implicit and applies everywhere. With `repos`, leave it out: each repo has its own |
| `repos` | (unset) | A multi-repo KB: each code repo by short name (its folder under `knowledge/`), with `source` (owner/name on the git host) and its own `areas`. Shared rules live in `knowledge/core/`, each repo's in `knowledge/<repo>/<area>/`, and a session gets only its own repo's rules. Then leave top-level `areas` and `sources.repos` out, and name areas elsewhere as `<repo>/<area>`. Unset, every rule applies to every repo |
| `topics` | (unset) | Topic name → one-line description. With topics, rules are grouped into one file per topic, `knowledge/<area>/<topic>.md`, each rule a `##` section; without them, each rule is its own file. In a multi-repo KB these are the shared rules' topics, and each repo lists its own as `repos.<name>.topics`. `general` is always allowed |
| `migrated.on` | (unset) | Written by `homeostat migrate`: the day it ran. A developer's sync moves their pending lessons created by then to the new layout; leave it as written |
| `migrated.areas` | (unset) | Written by `homeostat migrate`: each old area and the repo it moved to (`shared` for `knowledge/core/`) |

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
| `scoring.autoMergeThreshold` | `3` | Legacy: used only by `homeostat curate` run on its own. The [daily run](agents.md#daily) decides by `scoring.confidence` |
| `scoring.autoMerge.enabled` | `true` | Turn auto-merge off entirely |
| `scoring.autoMerge.areas` | `[]` | Areas that may auto-merge; empty means all |
| `scoring.autoMerge.excludeAreas` | `[]` | Areas that always need a reviewer, e.g. `core` |
| `scoring.autoMerge.maxPerRun` | `5` | Legacy: the most entries `homeostat curate`, run on its own, may auto-merge |
| `scoring.confidence.accept` | `70` | The daily run merges a lesson at or above this confidence (0–100) with no reviewer |
| `scoring.confidence.coreAccept` | `80` | The same, for `core` and global rules, which reach every session |
| `scoring.confidence.decline` | `35` | Lessons below this are declined; between `decline` and `accept` they go to a reviewer |
| `scoring.confidence.base.prFeedbackChangedCode` | `50` | Starting points: a review comment followed by a code change |
| `scoring.confidence.base.prFeedback` | `20` | a review comment with no code change after it |
| `scoring.confidence.base.manual` | `45` | written by a team member (`learn`, `/homeostat:learn`) |
| `scoring.confidence.base.agentHandoff` | `25` | written by an agent (handoff notes, MCP) |
| `scoring.confidence.base.deepDive` | `40` | produced by the deep dive |
| `scoring.confidence.roles.junior` | `0` | Added for the role of the person the lesson came from: its writer, or the reviewer it was drawn from |
| `scoring.confidence.roles.member` | `6` | |
| `scoring.confidence.roles.senior` | `14` | |
| `scoring.confidence.roles.lead` | `20` | |
| `scoring.confidence.bonus.areaOwner` | `6` | That person works in the lesson's area |
| `scoring.confidence.bonus.specific` | `8` | The rule names a concrete function, path or package |
| `scoring.confidence.bonus.goodTitle` | `4` | A clear title of three words or more |
| `scoring.confidence.bonus.repeat` | `10` | Per extra independent occurrence in the same run (up to two) |
| `scoring.confidence.bonus.modelRating` | `10` | The most the model's own rating of a drafted lesson adds or removes |
| `scoring.confidence.penalty.vagueTitle` | `15` | Subtracted for a title like "lesson1" |
| `scoring.confidence.penalty.conflict` | `25` | Subtracted when it contradicts an accepted rule (which also sends it to a person) |
| `scoring.confidence.penalty.flag` | `20` | Subtracted per open flag |
| `scoring.confidence.penalty.judge` | `30` | Subtracted when the judge finds a drafted rule claims what its review thread does not (which also sends it to a person; [details](agents.md#judge)) |
| `scoring.reviewCadence` | `weekly` | Reserved for review reminders; not used yet |

## `agents`

| Key | Default | Meaning |
| --- | --- | --- |
| `agents.runtime` | `api` | How the daily run, the deep dive, `bootstrap` and `migrate --topics` reach Claude: `api` (a Console key), `bedrock`, `vertex`, or `claude-code`. See [runtimes](../runtimes.md) |
| `agents.bedrock.region` | `AWS_REGION` | AWS region for `runtime: bedrock` |
| `agents.vertex.projectId` | `ANTHROPIC_VERTEX_PROJECT_ID` | Google Cloud project for `runtime: vertex` |
| `agents.vertex.region` | `global` | `global`, `us`, `eu` or a region |
| `agents.maxCostUsd` | (none: no cap) | Most US dollars one daily run, deep dive or `bootstrap` spends on model calls. No call starts once the run has spent it; what is left waits for the next run ([details](agents.md#spending-cap)). `homeostat daily --max-cost <usd>` overrides it for one run. Runtimes that report no cost (`api`, `bedrock`, `vertex`) are priced from their tokens, an estimate |
| `agents.curator.enabled` | `true` | Run the daily run under `homeostat up`. The `curator` settings (model, effort) also apply to `bootstrap`, `seed` and `migrate --topics` |
| `agents.curator.schedule` | `0 6 * * *` | Cron (UTC) for `homeostat up`; CI uses its own schedule |
| `agents.curator.model` | `claude-opus-5-5` | Any model id the runtime accepts |
| `agents.curator.effort` | `medium` | `low`, `medium`, `high`, `xhigh` or `max` |
| `agents.curator.lookbackHours` | `26` | How far back each run reads merged PRs |
| `agents.curator.consolidateCalls` | `30` | Most model calls per daily run that decide whether a new lesson updates, repeats or adds to the rules most like it ([details](agents.md#consolidate)). Lessons past the cap, and every lesson with `--no-reviews` or `0`, fall back to the word-overlap duplicate check |
| `agents.curator.judgeCalls` | `100` | Most model calls per daily run that judge a drafted rule about to merge with no person against its review thread ([details](agents.md#judge)). A pass takes one call, a failure three. Set it above the number of lessons a busy day merges on its own: `0` turns the judge off; drafts past the cap go to a reviewer, and the run says how many. A backfill (`daily --since`) raises it to cover every confident draft ([details](agents.md#judge)) |
| `agents.curator.judgeModel` | `claude-sonnet-5-5` | The judge's model. Empty means `claude-sonnet-5-5`, or `claude-opus-5-5` when `agents.curator.model` is already `claude-sonnet-5-5`, so the judge is never the drafter grading itself |
| `agents.curator.judgeEffort` | `medium` | The judge's effort |
| `agents.curator.retractCalls` | `10` | Most model calls per daily run that rewrite a document section citing a rule the run retires ([details](agents.md#retract)). `0` lists the sections instead |
| `agents.deepDive.enabled` | `true` | Run the deep dive under `homeostat up` |
| `agents.deepDive.schedule` | `0 7 * * 1` | Cron (UTC) |
| `agents.deepDive.model` | `claude-opus-5-5` | |
| `agents.deepDive.effort` | `medium` | |
| `agents.deepDive.lookbackHours` | `168` | Which rules count as "this week's" for the contradiction check |
| `agents.deepDive.staleAfterDays` | `180` | Accepted rules not confirmed for this long are retired; older document sections are flagged |
| `agents.deepDive.retractCalls` | `10` | Most model calls per deep dive that rewrite a document section citing a rule it retires as stale ([details](agents.md#retract)). `0` lists the sections instead |
| `agents.handoff.enabled` | `false` | Ask for a handoff note at the end of sessions with real edits. Opt-in: Claude Code shows the question as a "Stop hook error", and it costs one more turn |
| `agents.handoff.minEdits` | `5` | File edits before the note is asked for |

## `distribution`

| Key | Default | Meaning |
| --- | --- | --- |
| `distribution.exports` | all four | Which tools `homeostat export` writes for: `claude`, `cursor`, `agents-md`, `copilot` |
| `distribution.tokenBudget` | `2000` | Tokens of rules per session |
| `distribution.docTokenBudget` | `1000` | Tokens of document sections per session, on top of the rules |

## `notifications`

| Key | Default | Meaning |
| --- | --- | --- |
| `notifications.slackWebhookEnv` | (none) | Name of the environment variable or CI secret holding the Slack webhook URL for the [digest](agents.md#digest) and the daily run's morning notice. Never the URL itself. When it is set here but the variable is empty in the run, the daily run and the digest print `Slack: <NAME> is not set in this CI; no notice was posted` (the daily run also records it in its run report) |
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

Needed by the daily run, `review`, `bootstrap` and `migrate`, not by validation.

| Key | Default | Meaning |
| --- | --- | --- |
| `sources.host` | (required) | `github` or `bitbucket` |
| `sources.kbRepo` | (required) | `owner/name` of this KB repo: the only repo the agents write to |
| `sources.baseBranch` | `main` | Where the agents open pull requests |
| `sources.repos` | `[]` | A KB without repo folders: code repos whose merged PRs the daily run reads. With `repos`, leave it out; it is taken from each repo's `source` |
| `sources.exclude.repos` | `[]` | Repos never read |
| `sources.exclude.paths` | `[]` | Globs: review comments on these files are never read or sent |
