# Homeostat: technical design

As of 2026-10-21, version 0.2.1. For the threat model see [security.md](security.md); for every config key, [guide/config.md](guide/config.md).

## Overview

Homeostat turns a team's accepted code-review feedback into short, scored rules and sectioned team documents. It stores them as Markdown in a git repo, changes them only by pull request, and gives every coding agent the ones that apply to the files it is touching. It is on npm as `homeostat`, Apache-2.0, TypeScript on Node 22.18+. 0.2 added knowledge bases for several code repos, rules grouped into topic files, and `homeostat bootstrap`.

**Problem.** Reviewers teach agents the same lessons repeatedly, because agent memory is per session, per person and per tool. Claude Code's own memory is unreviewed, not shared across tools, and has no provenance.

**Goals**

- Capture lessons automatically from review threads that led to a code change, and by hand from sessions.
- Govern them like code: scored, validated, owned by a team, merged by PR.
- Deliver them to Claude Code, any MCP client, Cursor, Copilot and AGENTS.md, within a token budget.
- Make the data path auditable enough for a security review.

**Non-goals:** a hosted service, a vector database, per-laptop daemons, reading source code during normal operation (only `bootstrap` and `seed`, run by hand, read it).

**Hard constraints**

- Nothing scheduled runs on a developer's laptop. The agents run in the KB repo's CI or on one shared box.
- The agents read many repos but write only to the KB repo, and only by branch and PR.
- No secrets or company-specific content in the public repo; new dependencies need approval.

## Architecture

Three places run Homeostat, and only the KB repo holds state. The agents in CI read the code repos and write only to the KB repo, by pull request. Developer machines read a checkout of the KB repo; nothing scheduled runs there. Their sessions sync it in the background instead (see [Automation](#automation)).

```mermaid
flowchart TB
  code["Code repos<br/>GitHub or Bitbucket<br/>merged PRs + review threads<br/>read only; no source code"]
  subgraph ci["KB repo CI or shared box"]
    validate["Validate · every PR"]
    curator["Daily run · one PR per developer"]
    deep["Deep dive · weekly"]
    digest["Digest · weekly"]
  end
  model["Claude model<br/>API, Bedrock or Vertex<br/>redacted threads only"]
  slack["Slack<br/>webhook, no model"]
  kb[("KB repo · Markdown in git<br/>homeostat.yaml<br/>knowledge/repo/area/topic.md rules<br/>knowledge/repo/area/docs/ documents<br/>knowledge/core/ shared")]
  subgraph dev["Developer machine"]
    plugin["Claude Code plugin<br/>hooks inject rules<br/>skills: learn, explain"]
    mcp["MCP server<br/>any MCP client<br/>context, docs, read"]
    exports["Exports<br/>Cursor, Copilot,<br/>AGENTS.md files"]
    dash["Dashboard<br/>local event log<br/>settings, metrics"]
  end
  code --> curator
  curator --> model
  digest --> slack
  ci -- "daily PR per developer; merges past the confidence threshold<br/>decisions on homeostat/state" --> kb
  kb -- "selected rules + docs index, never raw files" --> dev
  plugin -- "session sync: pending lessons on candidates/member,<br/>pulls main and decisions" --> kb
```

The daily run sends the model redacted review threads, never code. Sessions get a rendered, selected view. A developer's lessons travel back only as a `candidates/<member>` branch.

| Package | Runs where | Role |
| --- | --- | --- |
| `@homeostat/core` | everywhere | pure logic: schema, validation, scoring, selection, scanners, the daily run's drafting, deep dive, bootstrap, providers, export |
| `homeostat` (CLI) | CI, shared box, laptops | commands, hook handlers, git and PR plumbing |
| `@homeostat/mcp` | laptops (stdio) | MCP server over the KB |
| `@homeostat/dashboard` | loopback on one machine | metrics and settings forms |
| `packages/plugin` | Claude Code | skills, SessionStart and Stop hooks, `.mcp.json` |

## Knowledge model

The KB is a git repo: `homeostat.yaml` at the root, rules under `knowledge/<area>/`, documents at `knowledge/<area>/docs/<topic>.md`. Areas map names to path globs in the code repos; `core` applies everywhere.

- **Repo folders** (optional): a KB serving several code repos lists them under `repos`, each with its own areas, and keeps each repo's knowledge in `knowledge/<repo>/<area>/`. Shared rules stay in `knowledge/core/`. Sessions, MCP and exports see their own repo plus core, found from the checkout's `origin` remote (or its folder name), and duplicates are compared only within a repo or against core.
- **Topic files** (optional): with a `topics` list, rules are grouped into `<area>/<topic>.md`, one `## Title {#id}` section per rule with its fields in a `<!-- homeostat … -->` YAML comment. Each section is read as a rule at a virtual path `<area>/<id>.md`, so validation, scoring and selection have one code path. Writers merge sections into the file sorted by id, and a conflicting PR is rebuilt from both sides. Without topics, each rule is its own file `<area>/<id>.md`.

**Rules** are one instruction each. YAML frontmatter holds machine fields, the body holds what agents read:

| Part | Contents |
| --- | --- |
| Identity | `id`, `title` (≤80 chars), `area`, `scope` (path globs), `topic` in a topic file |
| Lifecycle | `status`: candidate → accepted → disputed → retired; `approvedBy`, `flags` |
| Provenance | `source.type` (pr-feedback, manual, agent-handoff, deep-dive), `url`, `author`, `changedCode`, `created`, `lastConfirmed` |
| Kind | optional `kind` (convention, anti-pattern, migration, legacy, tech-debt, practice, review-lesson, decision); `adopted: false` marks a rejected decision |
| Cached | `score`, `tokens` (recomputed by `validate --fix`) |
| Body | `## Rule` ≤60 words, `## Why` ≤100 words, optional `## Example` |

**Documents** hold reference knowledge too long for a rule. Frontmatter: `title`, `area`, `owner`, `scope`, `updated`. The body is `## Heading {#id}` sections, each starting with `<!-- homeostat: source=… url=… updated=… confidence=… -->`. Stable ids let agents read and patch one section.

**Scoring** is computed, never hand-set: +3 review feedback followed by a code change, +2 written by hand, +1 senior author, −2 per conflict, −2 per open flag. All weights live in `scoring.weights`. The daily run decides with a separate 0–100 **confidence** (see [Automation](#automation)).

**Config** (`homeostat.yaml`, zod-validated) covers team members, teams and named reviewers, the code repos with their areas and topics (or one set of areas), scoring and auto-merge gates, agent runtimes and schedules, token budgets, notifications, security switches and git sources.

## Capture

Knowledge enters by four paths. All of them reach `main` only through the daily run's pull requests, never by a direct write.

**From reviews** (part of `homeostat daily`; `homeostat curate` runs the same pipeline on its own):

1. List PRs merged in the KB's code repos (`repos`, or `sources.repos` in a KB without repo folders) within `lookbackHours` (26). Skip PRs marked `homeostat:skip`, excluded repos, and authors who opted out.
2. Group review comments into threads. Keep a thread only if a team member wrote it, a commit followed it, it isn't in an excluded path, and it isn't already cited by a rule or document section, on the base branch or in an open review PR.
3. Redact secrets from the thread, then ask the model for one rule (structured output: keep, title, rule, why, area, and topic from the repo's list, or a suggested new one).
4. If a document's scope covers the commented file, ask for at most one section patch (replace or append) with `source=curator` provenance.
5. Build the entry, compute its score, and validate it against the whole KB. Risky-content findings keep a draft as a flagged candidate; any other error drops it.
6. File the lesson under the repo the PR came from and the developer whose PR it was, and score it with the rest of their lessons. A suggested new topic sends it to a reviewer, filed under `general`.

**By hand.** `homeostat learn` writes a lesson to the clone's git-ignored `.homeostat/pending/`, where it applies to that developer's sessions at once. Inputs: flags, prompts or a review-comment URL. The URL route fetches the comment and detects whether code changed after it. `learn --doc <area>/<topic> --section <id>` patches one document section. `/homeostat:learn` drafts from a session and asks before writing.

**Handoff notes.** The plugin's Stop hook counts edits in a session. After `handoff.minEdits` (5), it asks the agent once for a note, saved as a pending lesson with `--source agent-handoff`.

**Bootstrap and seed** (manual only; the only paths that read source code). `homeostat seed <checkout>` drafts one repo's documents, each topic from its own file picker: architecture, conventions and cross-repo from the tree and key files; data from schema dumps, ORM files found by a table definition in their text, and the newest migrations of every history; infrastructure from charts, Terraform, manifests, Dockerfiles and CI pipelines. Terraform state, env files, keys, secrets folders, Secret manifests, tests and files with three or more secret findings are never read; the rest is cut to size and redacted. `homeostat bootstrap` runs this for every repo from its local checkout, imports the repo's existing Markdown docs without a model, previews every file and the cost, asks before the first call, and opens one PR per repo with drafted sections marked `source=bootstrap`.

**Section patches** are byte-safe. `applySectionPatch` replaces, appends to or adds exactly one section, keeps every other byte, bumps `updated`, and refuses a patch that would break the document.

## Governance

Every change passes `homeostat validate`, which CI runs on each KB pull request. Validation is pure: it takes a map of files and returns issues, so the CLI, curator, MCP server and dashboard share it.

| Check | Catches | Result |
| --- | --- | --- |
| Schema | frontmatter shape, word limits, ids, dates, unknown keys | error |
| Config cross-checks | unknown areas, members, owners; one owning team per area | error |
| Secret scanner | about 35 token formats (cloud, code-host and package-registry tokens, AI, payment, messaging and commerce keys, webhooks), JWTs, private keys, credentialed and database URLs, passwords, Luhn-checked card numbers, high-entropy strings | error |
| Emails | personal data in rule text | warning |
| Risky content | piped shell, unlisted domains, credential handling, disabling security checks, injection phrasing, destructive commands, hidden text | error until `riskReviewedBy` |
| Provenance | a pr-feedback URL outside the KB's code repos | error |
| Topic files | a topic missing from the config, duplicate ids, unsorted sections | error or warning |
| Documents | duplicate headings or ids, repeated dates, wrapped or unclosed fences, conflict markers, sections over 400 words | error or warning |
| Conflicts | duplicate ids, near-duplicates, declared contradictions | error or warning |

**Merge is approval.** A rule is accepted by being merged, by the daily run past the confidence threshold or by a reviewer merging a review PR. Nobody edits `status` or `approvedBy` by hand.

## Automation

The goal: no per-lesson PRs, no per-lesson approvals, no per-developer setup, and nothing scheduled on laptops. Laptops and CI talk only through git refs on the KB repo's origin.

| Ref | Written by | Holds |
| --- | --- | --- |
| `main` | daily-run PRs, reviewers | the team KB |
| `candidates/<member>` | that developer's sync, force-pushed | `main` + their pending lessons + a heartbeat; transport only, never merged |
| `homeostat/state` | the daily run | `decisions/<member>.json` (with when each review opened and settled), `heartbeats/<member>.json`, `runs/<date>.json` (with the run's timing and the KB's health counts) |

**On the laptop: sync rides on session hooks.** `homeostat sync` runs detached in the background from the plugin's hooks: at SessionStart, on UserPromptSubmit at most every 3 hours (so a session left open for days still syncs), and at Stop when the pending set changed. Each sync:

1. fetches `main` and `homeostat/state`
2. clears pending lessons the daily run decided (matched by content hash), keeping a one-time notice for the next session
3. fast-forwards the clone when it is on `main` with clean tracked files; otherwise it notes how far behind it is
4. pushes pending lessons and a heartbeat to `candidates/<member>` when they changed, or when the heartbeat is 12 hours old; a member who opted in (`usage: true`) adds seven days of per-day usage counts to it

A long session gets only the rules that are new since its start, on the next prompt.

**In CI: `homeostat daily`**, the one scheduled job (06:00 UTC by default). It reads only what is already on the server, so closed laptops don't matter: a lesson written in the evening was pushed when its session stopped. For each member it:

1. collects pending lessons from `candidates/<member>` (new, update or flag-only) and the lessons drafted from reviews on their own merged PRs, skipping anything already decided
2. scores each lesson for **confidence** (0–100):
   - base points by source: review feedback with a code change 50, by hand 45, deep dive 40, agent handoff 25, review without a code change 20
   - the originator's role: junior +0, member +6, senior +14, lead +20 (for review lessons, the reviewer's role)
   - bonuses: area owner, specific (paths, code, identifiers), a clear title, repeated by others in the run, an optional model rating
   - penalties: open flags, conflicts, a vague title
3. decides each lesson:
   - merge at `accept` (70) or more, `coreAccept` (80) for `core` or a `**` scope
   - decline below 35, or on a validation error, or as a duplicate (which reconfirms the original)
   - otherwise review, and always for risky content, conflicts, documents and areas outside `scoring.autoMerge`
   - a flag merges at once (the rule becomes `disputed`) and a reviewer resolves it, in a dispute PR (below)
4. opens **one daily PR** per developer with the merged lessons and reconfirmations, every decision and its score breakdown in the body, validates the whole KB, and squash-merges it. Its commits carry `[skip ci]`, since the branch is deleted before a pipeline could start; the squash commit has its own message, so the base branch still runs CI. If the host refuses the merge (branch protection, a failing check), the PR stays open with a plain commit that lets its pipeline run, and its lessons count as review
5. after every developer's daily PR has merged, opens one **review PR** per developer for the middle band, so it starts level with the base branch, and requests reviewers: `team.reviewers` when set (also mentioned in the morning Slack notice), else the area's owning team, else members with that area, else seniors and leads
6. opens one **dispute PR** (`homeostat/review-dispute-<id>-<date>`) per disputed rule, with a fix the model drafts from the flags, or the rule retired when no fix can be drafted. Merging puts the fixed rule back in force; closing retires the rule
7. settles review PRs from earlier runs: merged by a reviewer means merged, closed means declined (for a dispute PR, the rule is retired through the next daily PR)
8. writes decisions, heartbeats and the run report to `homeostat/state`, and posts the review queue to Slack, repeating lessons that have waited more than 2 days

All thresholds and weights are in `scoring.confidence`. `--dry-run` decides and prints without writing anything.

**Merging review PRs.** In a KB with topic files, review PRs that add sections to the same file conflict once one of them merges. `homeostat review merge` rebuilds such a PR on the base branch, merging topic files section by section and documents section by section (two additions to one section are combined; two rewrites are not), waits until the host shows the rebuilt commit (an ordinary push nudges Bitbucket, which can miss a force push), and merges it. Bitbucket merges run asynchronously and are polled. A PR whose same rule changed on both sides is left for a person.

**Monitoring.** The dashboard's Automation page reads the clone's copy of `homeostat/state`, with no network call. It shows the last run, lessons decided per run, the review queue (overdue items marked), and each developer's sync health: last heartbeat, clone behind, pending count, version, and "not syncing" after 48 hours. The Performance page (and `homeostat metrics`) computes, from the same branch and the local event log, the share merged without a person, calibration per confidence band, review latency, reach and the cost of every step; see [guide/dashboard.md](guide/dashboard.md).

## Maintenance and ownership

**Deep dive** (weekly) merges near-duplicate rules into the higher-scoring one, asks the model about contradictions with the week's new rules, and retires rules unconfirmed for `staleAfterDays` (180). It notes document coverage gaps and stale sections, but never edits documents.

**Ownership.** `homeostat codeowners` generates CODEOWNERS. Each area goes to its owning team's handle (or its members), and seniors own the config and core. Reads stay org-wide: any session gets any team's rule whose scope matches its files.

## Delivery

Agents never read the stored files. They get a rendered view: no frontmatter, only the rules and sections that apply, under a token budget.

**Session start** (Claude Code plugin, SessionStart hook):

1. Find the KB from the plugin's `kb_dir` setting, then `$HOMEOSTAT_DIR`, then the current repo.
2. Collect touched paths from `git status` and recent commits.
3. Select accepted rules for the session's repo (found from the checkout's `origin` remote, else its folder name) plus the shared ones, minus rejected decisions and other teams' team-only areas. Rank them in tiers: rules scoped to the touched files, then global rules that name a touched file, then global rules that name no file, then those naming other files; by score within a tier.
4. Fit them into 80% of `distribution.tokenBudget` (2,000), within 10,000 characters overall, with room kept for the documents. Each rule goes in whole, else rule-only, else to the list of the rest: every remaining topic with its count, then titles while they fit, for the agent to fetch with `explain` or `context`.
5. Group by kind under one guidance line each, and add the context header (rules never override the user or safety).
6. Add a documents index (every document by title, then section ids while they fit) and the sections that name a touched path, within `docTokenBudget` (1,000).
7. Log an `injection` event.

**MCP server** (`homeostat mcp`, stdio) re-reads the KB on every call:

| Tool | Purpose |
| --- | --- |
| `context` | rules for given files, within a budget |
| `search` | keyword search, local, no model call; rejected decisions shown as context |
| `explain` | source, score breakdown, owner, conflicts |
| `docs`, `read` | list documents; read one, or one section, with its source |
| `report` | KB health over recent days |
| `learn`, `flag` | off unless `security.mcpWrites`; then at most `mcpWriteLimit` (5) per session |

Guessed tool names (`get_rules`, `remember`, `open`, …) resolve through an alias table and are logged as desire paths.

**Exports** (`homeostat export`) write each tool's native, path-scoped format into a code repo:

- Claude rules with `paths:` under `.claude/rules/homeostat/`
- Cursor `.mdc` files with `globs`
- Copilot instructions with `applyTo`, plus a block in `copilot-instructions.md`
- a marked AGENTS.md block, with documents under `.agents/homeostat/`

`--check` fails CI when they're stale. Team-only areas and rejected decisions are never exported, and public repos need `--allow-public`.

**Why this shape.** Measured on Claude, a lean Markdown render costs 1.0×, YAML or minified JSON 1.34×, the stored files with frontmatter 2.9×. Accuracy was identical across formats up to about 150k tokens, so selection and caching matter more than syntax.

## Security and data handling

The main threat is knowledge poisoning: one merged rule reaches every developer's agent, so a rule is effectively a prompt. Controls follow the data path.

| Data | Leaves the network? | Control |
| --- | --- | --- |
| Review threads (comment, PR title, file, line) | to the chosen model runtime | secrets redacted first; `--show-prompts` prints all, sends nothing; exclusions, skip marker, opt-out |
| Source code | only via manual `bootstrap` and `seed` | dry run with every file and the cost; never-read list; exclusions; redaction; asks first; never scheduled |
| KB content | to sessions and exports | team-only areas; public-repo guard on export |
| Local events (`.homeostat/events.db`) | never | git-ignored; size-only model-call logs; pruned after 90 days |
| Tokens | stay in CI secrets | never in files, prompts or logs; `doctor` checks their reach |

**Against poisoning:**

- the risky-content linter
- the auto-merge gates
- the provenance check
- agent-written entries capped at score 0 and labelled
- MCP writes off by default
- a session header that says rules never override the user or safety

**On laptops** the hooks and MCP server make no network calls of their own. The background sync fetches from and pushes to the KB repo's origin only (its `candidates/<member>` branch), with the developer's own git credentials. The dashboard binds to loopback, loads nothing external, and checks a per-run token plus Host and Origin on writes.

**Review package:** [data-handling.md](data-handling.md) (one page), [SECURITY.md](../SECURITY.md) (private advisories), and `homeostat doctor --security`. Doctor answers what is read, what leaves, who can change the rules, and the blast radius, against the live setup (branch protection, token write reach, KB visibility, pinned versions, runtime, exclusions, retention).

## Operations

**Model runtimes** sit behind one `Asker` interface (system, user, zod schema → typed result or null):

| Runtime | Path | Structured output |
| --- | --- | --- |
| `api` (default) | `@anthropic-ai/sdk`, Console key | `beta.messages.parse` with zod, server-side refusal fallback |
| `bedrock` | `AnthropicBedrockMantle`, AWS credential chain | one forced tool call |
| `vertex` | `AnthropicVertex`, Google ADC | one forced tool call |
| `claude-code` | `claude -p` with `--json-schema`, tools off | CLI schema; personal or Team/Enterprise plans only |

The default model is `claude-opus-5-5` at `medium` effort, configurable per agent. The cloud SDKs are optional peers, loaded only when chosen. Every call logs a `model-call` event with its size, never its content. See [runtimes.md](runtimes.md).

**Scheduling.** `init` writes the CI jobs: validate on every PR, the daily run (`homeostat daily`), the deep dive weekly, and a weekly read-only digest (GitHub Actions or Bitbucket Pipelines). `homeostat up` is the alternative for one shared box or the Docker image. It runs the same agents and the digest on their cron schedules, and serves the dashboard.

**Event log.** SQLite through `node:sqlite` at `.homeostat/events.db`, local to each machine. It records injections (with the hook's wall time and size), MCP calls (with their time) and desire paths, captures, flags, agent runs, model calls, document reads, syncs and auto-merges. It feeds `homeostat events`, `status`, `metrics`, the dashboard and the digest.

**Dashboard.** Server-rendered HTML with inline SVG charts, no framework. Pages: overview and agent liveness, automation (daily runs, review queue, developer sync), performance (decisions, calibration, review latency, reach, runtime), entries, members, coverage, impact, documents (section use and decay), desire paths, events, and settings forms for every config key (a test enforces that).

**Digest.** `homeostat digest` builds a Slack message without a model: new and reconfirmed rules, rejected decisions, updated sections, the review queue, flags and guessed tool names. It posts to the webhook named by `notifications.slackWebhookEnv`.

## Release and supply chain

Homeostat runs in every developer's session and in CI with tokens, so a compromised release is a top-tier risk. Releases are pinned, signed and small. See [releasing.md](releasing.md).

- **One exact version everywhere.** `scripts/version.mjs` sets it in every package, the plugin manifest, core's `VERSION`, the skills and docs. A test fails on drift or on any floating range. The plugin's npx fallback runs its own version, and `init` writes the exact version into CI.
- **Provenance.** A `v*` tag runs `release.yml` behind a required-reviewer `npm` environment. It checks the tag matches the version, runs the full check and `pnpm audit`, packs four packages, builds a CycloneDX SBOM, publishes with npm trusted publishing (OIDC, no stored token) and SLSA provenance, and attaches tarballs and SBOM to a GitHub release. 0.1.0 shipped this way on 2026-10-14, and every release since.
- **Runnable from source and from npm.** The bin runs TypeScript directly in a checkout (Node type stripping, `erasableSyntaxOnly`), and the compiled `dist/` when installed under `node_modules`.
- **Few dependencies:** zod, yaml, commander, minimatch, js-tiktoken, `@anthropic-ai/sdk`, the MCP SDK, plus optional Bedrock and Vertex SDKs. Renovate and pnpm `minimumReleaseAge` wait three days before taking a new version, and CI actions are pinned to commit SHAs.

| Package | Contents |
| --- | --- |
| `homeostat` | CLI and hook handlers; the only package users install |
| `@homeostat/core` | schemas, validation, scoring, selection, scanners, agents, providers, export |
| `@homeostat/mcp` | MCP server |
| `@homeostat/dashboard` | local dashboard |
| `packages/plugin` | Claude Code plugin (skills, hooks, `.mcp.json`), installed from the repo's marketplace |

## Decisions and open questions

| Decision | Why | Trade-off |
| --- | --- | --- |
| Markdown in git as the store | reviewable, diffable, works with CODEOWNERS and PRs; no service to run | agents need a rendered view, not the files |
| Rendered, selected view for agents | measured 2.9× cheaper than the raw files, same accuracy; less context rot | rules outside the budget reach the session only through MCP |
| Keyword search, no embeddings | no model or index to host; plain-file retrieval matches specialised memory on benchmarks | weaker on paraphrased queries |
| Agents in CI, not on laptops | no daemons, one place holding tokens | the team gets lessons daily; the author gets them at once |
| Sync on session hooks | no laptop scheduler or per-developer setup; works when laptops are closed at 06:00 | a developer with no sessions doesn't sync (the dashboard shows it) |
| Decide by confidence, humans only for the middle band | no per-lesson approvals; the role of whoever vouches for a lesson counts | relies on the weights and branch protection being right |
| Repo folders in one KB | a team owning several repos keeps one KB; globs that collide across repos (`services/**`) stay apart | areas are named `<repo>/<area>`; a KB without folders keeps working |
| Rules grouped into topic files | a few files per area instead of hundreds; the drafter picks from a fixed topic list | PRs touching one file conflict, so they are rebuilt section by section |
| Section-level document edits | whole-file rewrites caused most of the pilot's document damage | bigger changes take several patches |
| TypeScript, one pnpm monorepo | one language for CLI, MCP, plugin and dashboard; npx install | no Python SDK users |
| Default runtime `api`, cloud runtimes optional | team-safe terms; data can stay in AWS or Google Cloud | three code paths to keep working |

**Open questions**

- Should `scope` accept language or framework selectors (`lang:ts`) as well as path globs?
- Should the confidence weights tune themselves from reviewers' decisions on the middle band?
- Should the deep dive re-check document sections against code? That needs code access, which only `seed` and `bootstrap` have today.
- The event log is per machine, so usage and decay reflect one developer. Should there be an opt-in shared aggregate?
- `scoring.reviewCadence` is defined but not used yet.
- Not yet verified live: Bedrock and Vertex runs, a real Slack digest, and Cursor and Claude Desktop checks.
