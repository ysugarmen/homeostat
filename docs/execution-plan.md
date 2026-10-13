# Execution plan

This tab turns the design doc into an ordered list of steps. Every step has a **deliverable** and a **done when** test; a box gets ticked only when the test is true. We work through it one step at a time: pick the next unticked step, draft it together, verify, tick, move on. Weeks are a guide for a single engineer at roughly half time; stretch them, don't skip steps.

## Design constraint: zero per-machine maintenance

The first internal attempt died on one thing: every developer's machine had to be installed, updated and kept running on a cron, and the crons kept failing. This plan treats that as a hard constraint. Rule: **nothing scheduled ever runs on a developer's laptop, and a developer installs once and never updates by hand.**

| Concern | Where it runs | Why it needs no per-machine upkeep |
| --- | --- | --- |
| Curator (daily PR scan), deep-dive (weekly), scoring, conflict check, export | **One place:** a scheduled CI workflow in the KB repo (GitHub Actions cron / Bitbucket Pipelines schedule), or one central instance via `up` on a shared box | Runs server-side on a schedule the platform guarantees; one config, one log, one thing to fix |
| Personal lessons from a developer's own sessions | Claude Code **hooks** (Stop, PreCompact) inside the plugin | Hooks fire inside the session; no cron. The hook writes a candidate entry (a commit on a `candidates/<user>` branch or a PR) and the central curator scores and merges it |
| Injecting relevant rules into a session | SessionStart hook reads committed entries from the repo | The KB and the exported rules files are **in git**; a developer gets updates by pulling, which they do anyway |
| The plugin itself | Claude Code marketplace | Marketplace plugins update automatically; install is one command, once |
| Dashboard | Same central instance as the agents, or CI-published static report | Nobody runs it locally unless they want to |

Consequences for the steps below: 2.5 and 2.6 ship as CI workflow templates first and as `up` daemons second; 2.3 and 2.4 must be pure hooks with no background process; `init` writes the CI workflow into the KB repo so scheduling is set up once, centrally. Fallback if hooks prove unreliable: drop personal capture to manual `/learn` only and keep the single central instance; the loop still closes, just with fewer sources.

**Hosting split (decided):** the product's own code lives on **GitHub** (public, personal). The pilot team's KB and all its repos are on **Bitbucket**, so Bitbucket is the first provider the agents must support, because the dogfood in Phase 5 happens there. The provider layer in `packages/core` therefore has two implementations from the start: `BitbucketProvider` (PR list, review comments, open PR) and `GitHubProvider`, with the same interface. CI templates ship for both: `bitbucket-pipelines.yml` with a schedule, and `.github/workflows/curator.yml` with a cron. The public repo's own CI runs on GitHub Actions and tests both providers against recorded fixtures, never against live data from the pilot team.

**Permissions model (decided):** the GitHub account and the Bitbucket workspace never share credentials. The public repo holds code only, no secrets. Agents run inside the consuming team's own CI and authenticate with a token that the team owns:

- **Bitbucket:** a *workspace access token* (or repository access tokens) with `pullrequest:read` and `repository:read` on the code repos and `repository:write` + `pullrequest:write` on the KB repo. Stored as a secured pipeline variable in the KB repo, where the scheduled pipeline lives. Owned by the workspace, not by a person, so it survives staff changes. A personal app password is acceptable only for the first pilot run.
- **GitHub:** the built-in `GITHUB_TOKEN` of the Actions workflow for same-repo access; a fine-grained PAT or GitHub App installation when the curator must read other repos in the org.
- **Read many, write one:** the curator reads PRs from every configured code repo but writes only to the KB repo (branch + PR, never direct to main). `init` prints the exact scopes needed so a workspace admin can mint the token without guessing.
- **Local hooks:** use whatever git credentials the developer already has, because the hook only commits to a `candidates/<user>` branch of the KB repo they already clone.

## Phase 0 — Decisions that unblock everything (week 1)

Nothing below needs code. Each one blocks a later phase if left open.

- [ ] **0.1 Name.** Pick from the shortlist in the design doc. *Done when:* GitHub org, npm package name and a `.dev` or `.sh` domain are reserved under the bare name.
- [x] **0.2 Licence.** Recommend **Apache-2.0**: permissive enough for teams to adopt without legal review, explicit patent grant, and it keeps a hosted tier possible later. Choose AGPL only if the plan is to sell hosting from day one. *Done when:* `LICENSE` is committed and the choice is in the README. **Decided:** Apache-2.0.
- [ ] **0.3 Employer sign-off.** Ask three things in writing: (1) the employer owns no claim on the public repo, (2) agreed time allocation per week, (3) no employer data, names or repo structure may appear publicly. *Done when:* a written yes from the CTO is filed in the private repo.
- [x] **0.4 Language and runtime.** Recommend **TypeScript** for everything: the CLI, the MCP server, the agents and the dashboard share one codebase, `npx <name> init` is the lowest-friction install, the MCP SDK and Claude Code plugin tooling are first-class in Node, and the dashboard is a web app anyway. Avoid two languages. *Done when:* decided and recorded here. **Decided:** TypeScript, pnpm workspace, Node ≥ 22.
- [x] **0.5 Repo layout.** One monorepo `<org>/<name>` with `packages/core` (schema, scoring, validate), `packages/cli`, `packages/mcp`, `packages/plugin` (Claude Code plugin files), `packages/dashboard`, `examples/starter-kb`. The pilot team's KB stays in its own private repo that consumes the public tool. *Done when:* an empty monorepo exists with the folders and a CI workflow that runs the tests on every PR.

## Phase 1 — Extract the core from the pilot (weeks 1–2)

Goal: a public-safe core with a defined data model, separated from anything specific to the pilot team.

- [ ] **1.1 Inventory.** List every file in the two pilot repos (kept private); tag each as *generic*, *pilot-specific* (team names, area definitions, Bitbucket pipeline, Slack ids, local cron paths) or *drop*. *Done when:* a table in the private repo lists all files with their tag.
- [x] **1.2 Knowledge entry schema.** The heart of the product; everything else reads or writes it. One markdown file per entry with YAML frontmatter: `id`, `title`, `scope` (glob paths the entry applies to), `area`, `source` (`type`: pr-feedback | manual | agent-handoff | deep-dive; `url`; `author`), `score`, `owner`, `status` (candidate | accepted | disputed | retired), `created`, `lastConfirmed`, `conflictsWith`, `tokens` (cached count). Body: the rule in one paragraph, then a *why*, then an optional *example*. *Done when:* `schema.json` validates and three real entries from the pilot are rewritten in the format. **Status:** `packages/core/schema/entry.schema.json` is generated from the zod schema; `examples/starter-kb` has three generic entries in the format (generic rather than pilot entries, to keep the public repo clean).
- [x] **1.3 Config file.** `kbx.yaml` at the KB repo root: `team` (members with id, role senior|member, areas), `areas` (name → path globs), `scoring` (the +3/+2/+1/−2 rules as editable weights, auto-merge threshold, review cadence), `agents` (curator schedule, deep-dive schedule, enabled flags), `distribution` (which rules files to export, token budget per session), `notifications` (Slack webhook, digest day). *Done when:* an example config exists and `validate` rejects a malformed one with a clear message.
- [x] **1.4 Scoring and validation as a library.** Port the Bitbucket pipeline logic into `packages/core`: `score(entry, context)`, `detectConflicts(entries)`, `validate(repo)`. Pure functions, no I/O, unit-tested, because the CLI and the CI job both call them. *Done when:* tests cover each scoring rule and the conflict case, and `validate` runs green on `examples/starter-kb`.
- [x] **1.5 CODEOWNERS generation.** Port the auto-generator from `team.json` to the new config. *Done when:* running it on the example produces a correct CODEOWNERS.
- [x] **1.6 Scrub.** *Done when:* a search for the employer's name across the public repo returns nothing, and no real person or customer name appears in examples.

## Phase 2 — CLI and Claude Code plugin (weeks 3–5)

Goal: a developer on any team can install it in one command and see the loop close once.

- [x] **2.1 CLI skeleton.** Commands: `init` (scaffolds config and a starter KB in the current repo, detects GitHub vs Bitbucket), `learn` (capture an entry interactively or from a PR comment URL), `validate`, `export`, `up` (starts agents and dashboard), `status`. *Done when:* `npx <name> init` on an empty repo leaves a valid KB behind. **Status:** `init`, `learn`, `validate` and `codeowners` work; `export`, `up` and `status` are registered stubs that name their step. `learn` takes flags, prompts in a terminal, or a Bitbucket/GitHub review-comment URL (token from `KBX_BITBUCKET_TOKEN` / `KBX_GITHUB_TOKEN`); it writes the file and leaves committing to the user. Verified with the local binary, since the package is not on npm yet. `init` writes a validate-only CI file; the scheduled curator job is added with 2.5.
- [x] **2.2 Plugin package.** `.claude-plugin/plugin.json`, skills for `/learn`, `/explain` and `/review`, `.mcp.json` pointing at the bundled MCP server. *Done when:* it installs from a local path through the Claude Code plugin command. **Status:** installed via `claude plugin marketplace add <repo>` + `claude plugin install kbx@kbx` (local scope, then removed); both manifests pass `claude plugin validate --strict`. `.mcp.json` is deferred to Phase 3 so the plugin never points at a server that does not exist yet.
- [x] **2.3 SessionStart hook.** On session start, read what the user is likely to touch (git status, recent branches), select entries whose `scope` matches, rank by score, inject under `distribution.tokenBudget`. Log what was injected. *Done when:* a session in a repo with ten entries injects only the relevant ones and stays under budget. **Status:** verified in a live `claude -p --plugin-dir` session: 6 of 10 entries injected (467 of 2000 tokens), the four irrelevant ones left out. The KB is found via the plugin's `kb_dir` setting, then `$KBX_DIR`; injections are logged to the KB's git-ignored `.kbx/events.jsonl` until Phase 4's event store.
- [x] **2.4 Stop / PreCompact handoff notes.** On session end, ask the model for a short handoff note (what was decided, what was tried and rejected) and store it as a `candidate` entry with `source.type: agent-handoff`. *Done when:* a note appears in the KB after a session ends. **Status:** Stop fires after every turn and SessionEnd cannot reach the model, so the Stop hook asks once per session, after `agents.handoff.minEdits` file edits (or after a compaction, flagged by PreCompact), and the agent saves the note with `kbx learn --source agent-handoff --branch candidates/<member>` (plus `--push` when the KB has an origin). The commit is made with git plumbing, so the KB checkout is untouched. Verified in a live `claude -p` session: the note landed on `candidates/lee`.
- [ ] **2.5 Curator agent.** Daily: list merged PRs since last run, pull review threads where a comment was followed by a code change (the +3 signal), draft entries, score them, open one PR to the KB repo with all candidates. Provider interface with Bitbucket first, GitHub second. *Done when:* it runs against a test repo and opens a correct PR. **Status:** built, not yet run live. `kbx curate` scans `sources.repos`, keeps reviewer threads followed by a code change that the KB lacks (deduped by repo/PR/comment id), drafts each with Claude via `@anthropic-ai/sdk` structured outputs, scores and validates it, commits all to a `kbx/curator-<date>` branch and opens one PR on `sources.kbRepo`; it also opens PRs for pushed `candidates/*` branches. `init` writes the scheduled job (GitHub cron workflow; Bitbucket custom pipeline, scheduled in the UI). Tested against recorded fixtures and a stub drafter. The live run needs an `ANTHROPIC_API_KEY` and a review comment from a second account; it is part of the 2.8 demo.
- [x] **2.6 Deep-dive agent.** Weekly: read the week's accepted entries, merge near-duplicates, raise conflicts, retire stale ones. *Done when:* it correctly merges two seeded duplicates. **Status:** `kbx deep-dive` merges accepted near-duplicate pairs into the higher-scoring entry (scope union, `supersedes`, the other retired; Claude writes the combined text, `--no-llm` keeps the survivor's), asks Claude whether entries added or confirmed this week contradict overlapping accepted ones (both become `disputed`), retires entries unconfirmed for `agents.deepDive.staleAfterDays` (180), and opens one PR. Merging the seeded pair is verified in tests and with the real binary; the Claude parts are tested with stubs only. `init` schedules it weekly.
- [ ] **2.7 Export.** `export` writes accepted entries into `.claude/rules/`, `.cursor/rules/`, `AGENTS.md` and `.github/copilot-instructions.md`, one file per area, with a generated-file header. *Done when:* Cursor and Copilot pick up a rule without configuration. **Status:** built; Cursor and Copilot not yet confirmed. `kbx export --kb <kb> --out <code repo>` writes `.claude/rules/kbx/<area>.md` (`paths`), `.cursor/rules/kbx/<area>.mdc` (`globs`, `alwaysApply`), `.github/instructions/kbx/<area>.instructions.md` (`applyTo`), and marked blocks in `.github/copilot-instructions.md` (always-on rules, the only file github.com Chat reads) and `AGENTS.md`, keeping hand-written content and removing stale files only in kbx's own folders; `--check` for CI. Formats follow each tool's docs as of 2026-10-13. Verified live in Claude Code (core rule at launch, area rule once a matching file is read); Cursor and Copilot need a manual check.
- [ ] **2.8 End-to-end check.** On a fresh repo: init, leave a review comment, merge the fix, run the curator, approve the entry, start a Claude Code session, confirm the rule is applied. This becomes the demo script. *Done when:* the whole loop runs in under ten minutes by hand.

## Phase 3 — MCP server (weeks 5–6)

- [ ] **3.1 Tools.** `search`, `context` (same selection logic as the hook), `learn`, `explain` (why a rule exists, with source link), `flag` (dispute an entry), `report` (KB health). *Done when:* each tool has a test and a description under 200 characters.
- [ ] **3.2 Unknown-call logging.** Log every tool name the model attempts that doesn't exist; surface it in the dashboard as a desire path. *Done when:* a fake call shows up in the log.
- [ ] **3.3 Cross-client check.** *Done when:* Claude Desktop and Cursor both list the server and `search` returns results.

## Phase 4 — Dashboard (weeks 6–9)

- [ ] **4.1 Event log.** SQLite file inside the KB repo (git-ignored) by default, one table of events: agent runs, entries created/accepted/retired, injections, tool calls. Every agent and hook writes to it. *Done when:* a day of use produces a readable log.
- [ ] **4.2 Setup pages.** Team and members, repos and sources, scoring rules, agent schedules, distribution, notifications: each a form that writes back to `<name>.yaml` with validation. *Done when:* every config key is editable without touching YAML.
- [ ] **4.3 Metrics pages.** Agent liveness (last run, next run, failures), per-member contributions (entries, accepted ratio; framed as input to the shared KB, visible to all), KB health (entries by status, average age, open conflicts), repo view (coverage by path), impact (injections per session, rules applied). *Done when:* all five render from the event log.
- [ ] **4.4 Local-first.** `up` serves it on localhost; Docker image as the second option. No auth in v1 because it is local. *Done when:* `up` opens the dashboard with live data in one command.

## Phase 5 — Dogfood with the pilot team (weeks 8–10, overlaps Phase 4)

- [ ] **5.1 Migrate the pilot** to the public tool with the pilot team's private KB as the consumer. Same four reps, two weeks.
- [ ] **5.2 Measure:** entries captured per week, accepted ratio, time to first injection, rules applied per session, a three-question developer survey. *Done when:* numbers are in a short write-up by the pilot write-up date in the design doc.
- [ ] **5.3 Fix the top five pain points** before launch.

## Phase 6 — Launch (weeks 10–12)

- [ ] **6.1 README** with a 90-second demo GIF of the end-to-end loop, one-command install, and the "why this exists" paragraph from the executive summary.
- [ ] **6.2 Docs site:** quickstart, entry format, config reference, agents, MCP, dashboard, contributing.
- [ ] **6.3 CONTRIBUTING, code of conduct, issue templates, good-first-issue labels.**
- [ ] **6.4 Claude Code marketplace submission.**
- [ ] **6.5 Announce:** Show HN, r/ClaudeAI, the Claude Code Discord, a short post from the pilot team's engineering blog, direct notes to people writing about agent memory.
- [ ] **6.6 Decision checkpoint** at the date set in the design doc: stars, installs, external PRs, inbound hosting requests. Decide whether a hosted tier is worth building.

## Step 1.2 draft — Knowledge entry schema

One entry = one markdown file at `knowledge/<area>/<id>.md`. Frontmatter is the machine-readable part; the body is what gets injected into a session. Keep bodies short: the `tokens` field is cached so the injector can budget without re-counting.

### Frontmatter fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string, `^[a-z0-9-]+$` | yes | Stable slug, equals the filename. Never changes after creation. |
| `title` | string ≤ 80 chars | yes | Imperative sentence: "Use the retry helper for outbound HTTP". |
| `area` | string | yes | Must match a key in `areas` in the config, or `core`. |
| `scope` | string\[\] (globs) | yes | Paths the rule applies to. `["**"]` for global. Drives injection. |
| `status` | `candidate` \| `accepted` \| `disputed` \| `retired` | yes | Only `accepted` is injected or exported. |
| `score` | integer | yes | Computed by `score()`, never hand-edited; CI rewrites it. |
| `owner` | string (member id) | yes | Who answers questions about it. Feeds CODEOWNERS. |
| `source.type` | `pr-feedback` \| `manual` \| `agent-handoff` \| `deep-dive` | yes | Decides the base score. |
| `source.url` | URL | if pr-feedback | The PR comment thread. Proof. |
| `source.author` | member id | yes | Who originated it; seniority feeds +1. |
| `source.changedCode` | boolean | if pr-feedback | The +3 signal: feedback followed by a code change. |
| `created` | date | yes | ISO date. |
| `lastConfirmed` | date | yes | Bumped when a reviewer re-approves or the deep-dive re-validates. Staleness = today − lastConfirmed. |
| `approvedBy` | member id | no | Reviewer who approved the entry; lets an entry be `accepted` below the auto-merge threshold. |
| `conflictsWith` | string\[\] (ids) | no | Set by `detectConflicts()`; non-empty forces `disputed`. |
| `supersedes` | string | no | Id of the entry this one replaces; the old one goes `retired`. |
| `tags` | string\[\] | no | Free-form, for search only. |
| `tokens` | integer | yes | Cached token count of the body; CI recomputes. |

### Body structure

Three sections, fixed headings, so parsers and humans agree:

1. **Rule** (required, one paragraph, ≤ 60 words). The thing the agent must do. This is the only section injected when the budget is tight.
2. **Why** (required, ≤ 100 words). The reason, so the agent can judge edge cases and `explain` has something to say.
3. **Example** (optional). A short code block showing right vs wrong.

### Example entry

````markdown
---
id: outbound-http-retry-helper
title: Use the shared retry helper for outbound HTTP calls
area: integrations
scope: ["services/integrations/**", "packages/http-client/**"]
status: accepted
score: 4
owner: dana
source:
  type: pr-feedback
  url: https://bitbucket.org/acme/integrations-api/pull-requests/812#comment-33
  author: dana
  changedCode: true
created: 2026-09-30
lastConfirmed: 2026-10-07
tags: [http, resilience]
tokens: 92
---

## Rule
Wrap every outbound HTTP call to a partner API in `withRetry()` from `@app/http-client`. Do not hand-roll retry loops or use `axios-retry` directly.

## Why
Partner APIs time out often; the helper adds jittered backoff, a circuit breaker and the request id header the on-call team searches logs by. Hand-rolled loops skipped the header twice in Q3 and made incidents unsearchable.

## Example
```ts
// wrong
for (let i = 0; i < 3; i++) { try { return await axios.get(url) } catch {} }
// right
return withRetry(() => axios.get(url), { attempts: 3 })
````

The Example section ends with the closing fence of the `ts` block; the outer file has no further content.

### Validation rules (what `validate` enforces)

- Filename equals `id`; folder equals `area`.
- `status: accepted` requires `score ≥ scoring.autoMergeThreshold` or `approvedBy` set to a member id.
- `conflictsWith` non-empty ⇒ `status` must be `disputed`.
- `source.type: pr-feedback` ⇒ `source.url` present.
- Body has `## Rule` and `## Why`; Rule ≤ 60 words.
- `tokens` matches the recomputed count. A mismatch is a *fixable* warning: `kbx validate --fix` rewrites it, so CI fixes it rather than failing.

### Open points for review

- [x] ~~Is `vertical` the right word publicly, or `area` / `domain`?~~ **Decided:** `area` (field, folder, config key `areas`).
- [ ] Should `scope` also allow language or framework selectors (`lang:ts`), or paths only for v1?
- [ ] Do we want a `confidence` separate from `score`, or is score enough?
- [ ] Write three real pilot entries in this format and see what breaks.

## Decisions log

Session 1 (2026-10-13), agreed before Phase 1 code:

- **Name:** `kbx` is the placeholder in code, paths and package names; renaming is one find-and-replace.
- **Provider order:** Bitbucket first, GitHub second.
- **`detectConflicts()` is deterministic** (pure, no LLM): duplicate ids, `supersedes` cycles or dangling targets, one-sided `conflictsWith` links, and accepted entries with overlapping scope and near-identical titles. Semantic contradictions are the deep-dive agent's job (2.6).
- **Approval** is recorded as an optional `approvedBy` field, so `validate()` stays pure.
- **Token counts** use `js-tiktoken` (`cl100k_base`) as an approximation; good enough for budgeting, documented as approximate.
- **Tooling:** Biome for lint and format; `typescript` and `@types/node` as dev dependencies.
- **Claude API (2.5):** the agents use `@anthropic-ai/sdk` (approved 2026-10-13) with structured outputs and the default refusal fallback. Model and effort are per agent in `kbx.yaml` (`agents.curator.model`, default `claude-opus-5-5`, effort `medium`).
- **CODEOWNERS (1.5):** members get an optional `handle` (`@user`, `@org/team` or an email), because member ids are not platform identities. Seniors own `*` and `kbx.yaml`; members listing an area own `knowledge/<area>/` (seniors if nobody does); an entry owner outside the area gets a line for that entry. `kbx codeowners --check` lets CI catch a stale file.

## Working agreement

One step per session, in order, unless a dependency says otherwise. For each step I draft the artefact (schema, code, config, doc), you review, and we verify the *done when* test together before ticking the box.

**Start here:** 1.2, the entry schema. It needs no name and no sign-off, and every other step depends on it.
