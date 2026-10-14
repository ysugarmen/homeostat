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

- [ ] **0.1 Name.** Pick from the shortlist in the design doc. *Done when:* GitHub org, npm package name and a `.dev` or `.sh` domain are reserved under the bare name. **Status:** name chosen: Homeostat (see the decisions log). Nothing reserved yet; the bare GitHub name is taken by an existing account.
- [x] **0.2 Licence.** Recommend **Apache-2.0**: permissive enough for teams to adopt without legal review, explicit patent grant, and it keeps a hosted tier possible later. Choose AGPL only if the plan is to sell hosting from day one. *Done when:* `LICENSE` is committed and the choice is in the README. **Decided:** Apache-2.0.
- [ ] **0.3 Employer sign-off.** Ask three things in writing: (1) the employer owns no claim on the public repo, (2) agreed time allocation per week, (3) no employer data, names or repo structure may appear publicly. *Done when:* a written yes from the CTO is filed in the private repo.
- [x] **0.4 Language and runtime.** Recommend **TypeScript** for everything: the CLI, the MCP server, the agents and the dashboard share one codebase, `npx <name> init` is the lowest-friction install, the MCP SDK and Claude Code plugin tooling are first-class in Node, and the dashboard is a web app anyway. Avoid two languages. *Done when:* decided and recorded here. **Decided:** TypeScript, pnpm workspace, Node ≥ 22.
- [x] **0.5 Repo layout.** One monorepo `<org>/<name>` with `packages/core` (schema, scoring, validate), `packages/cli`, `packages/mcp`, `packages/plugin` (Claude Code plugin files), `packages/dashboard`, `examples/starter-kb`. The pilot team's KB stays in its own private repo that consumes the public tool. *Done when:* an empty monorepo exists with the folders and a CI workflow that runs the tests on every PR.

## Phase 1 — Extract the core from the pilot (weeks 1–2)

Goal: a public-safe core with a defined data model, separated from anything specific to the pilot team.

- [ ] **1.1 Inventory.** List every file in the two pilot repos (kept private); tag each as *generic*, *pilot-specific* (team names, area definitions, Bitbucket pipeline, Slack ids, local cron paths) or *drop*. *Done when:* a table in the private repo lists all files with their tag.
- [x] **1.2 Knowledge entry schema.** The heart of the product; everything else reads or writes it. One markdown file per entry with YAML frontmatter: `id`, `title`, `scope` (glob paths the entry applies to), `area`, `source` (`type`: pr-feedback | manual | agent-handoff | deep-dive; `url`; `author`), `score`, `owner`, `status` (candidate | accepted | disputed | retired), `created`, `lastConfirmed`, `conflictsWith`, `tokens` (cached count). Body: the rule in one paragraph, then a *why*, then an optional *example*. *Done when:* `schema.json` validates and three real entries from the pilot are rewritten in the format. **Status:** `packages/core/schema/entry.schema.json` is generated from the zod schema; `examples/starter-kb` has three generic entries in the format (generic rather than pilot entries, to keep the public repo clean).
- [x] **1.3 Config file.** `homeostat.yaml` at the KB repo root: `team` (members with id, role senior|member, areas), `areas` (name → path globs), `scoring` (the +3/+2/+1/−2 rules as editable weights, auto-merge threshold, review cadence), `agents` (curator schedule, deep-dive schedule, enabled flags), `distribution` (which rules files to export, token budget per session), `notifications` (Slack webhook, digest day). *Done when:* an example config exists and `validate` rejects a malformed one with a clear message.
- [x] **1.4 Scoring and validation as a library.** Port the Bitbucket pipeline logic into `packages/core`: `score(entry, context)`, `detectConflicts(entries)`, `validate(repo)`. Pure functions, no I/O, unit-tested, because the CLI and the CI job both call them. *Done when:* tests cover each scoring rule and the conflict case, and `validate` runs green on `examples/starter-kb`.
- [x] **1.5 CODEOWNERS generation.** Port the auto-generator from `team.json` to the new config. *Done when:* running it on the example produces a correct CODEOWNERS.
- [x] **1.6 Scrub.** *Done when:* a search for the employer's name across the public repo returns nothing, and no real person or customer name appears in examples.

## Phase 2 — CLI and Claude Code plugin (weeks 3–5)

Goal: a developer on any team can install it in one command and see the loop close once.

- [x] **2.1 CLI skeleton.** Commands: `init` (scaffolds config and a starter KB in the current repo, detects GitHub vs Bitbucket), `learn` (capture an entry interactively or from a PR comment URL), `validate`, `export`, `up` (starts agents and dashboard), `status`. *Done when:* `npx <name> init` on an empty repo leaves a valid KB behind. **Status:** `init`, `learn`, `validate` and `codeowners` work; `export`, `up` and `status` are registered stubs that name their step. `learn` takes flags, prompts in a terminal, or a Bitbucket/GitHub review-comment URL (token from `HOMEOSTAT_BITBUCKET_TOKEN` / `HOMEOSTAT_GITHUB_TOKEN`); it writes the file and leaves committing to the user. Verified with the local binary, since the package is not on npm yet. `init` writes a validate-only CI file; the scheduled curator job is added with 2.5.
- [x] **2.2 Plugin package.** `.claude-plugin/plugin.json`, skills for `/learn`, `/explain` and `/review`, `.mcp.json` pointing at the bundled MCP server. *Done when:* it installs from a local path through the Claude Code plugin command. **Status:** installed via `claude plugin marketplace add <repo>` + `claude plugin install homeostat@homeostat` (local scope, then removed); both manifests pass `claude plugin validate --strict`. `.mcp.json` is deferred to Phase 3 so the plugin never points at a server that does not exist yet.
- [x] **2.3 SessionStart hook.** On session start, read what the user is likely to touch (git status, recent branches), select entries whose `scope` matches, rank by score, inject under `distribution.tokenBudget`. Log what was injected. *Done when:* a session in a repo with ten entries injects only the relevant ones and stays under budget. **Status:** verified in a live `claude -p --plugin-dir` session: 6 of 10 entries injected (467 of 2000 tokens), the four irrelevant ones left out. The KB is found via the plugin's `kb_dir` setting, then `$HOMEOSTAT_DIR`; injections are logged to the KB's git-ignored `.homeostat/events.jsonl` until Phase 4's event store.
- [x] **2.4 Stop / PreCompact handoff notes.** On session end, ask the model for a short handoff note (what was decided, what was tried and rejected) and store it as a `candidate` entry with `source.type: agent-handoff`. *Done when:* a note appears in the KB after a session ends. **Status:** Stop fires after every turn and SessionEnd cannot reach the model, so the Stop hook asks once per session, after `agents.handoff.minEdits` file edits (or after a compaction, flagged by PreCompact), and the agent saves the note with `homeostat learn --source agent-handoff --branch candidates/<member>` (plus `--push` when the KB has an origin). The commit is made with git plumbing, so the KB checkout is untouched. Verified in a live `claude -p` session: the note landed on `candidates/lee`.
- [x] **2.5 Curator agent.** Daily: list merged PRs since last run, pull review threads where a comment was followed by a code change (the +3 signal), draft entries, score them, open one PR to the KB repo with all candidates. Provider interface with Bitbucket first, GitHub second. *Done when:* it runs against a test repo and opens a correct PR. **Status:** verified live on 2026-10-13: against a sandbox repo it read the merged PR, kept the second account's review thread (followed by a code change), drafted the entry through Claude, scored it 4 (accepted) and opened a correct PR on the KB repo. `homeostat curate` scans `sources.repos`, keeps reviewer threads followed by a code change that the KB lacks (deduped by repo/PR/comment id), drafts each with Claude via `@anthropic-ai/sdk` structured outputs, scores and validates it, commits all to a `homeostat/curator-<date>` branch and opens one PR on `sources.kbRepo`; it also opens PRs for pushed `candidates/*` branches. `init` writes the scheduled job (GitHub cron workflow; Bitbucket custom pipeline, scheduled in the UI). Tested against recorded fixtures and a stub drafter. The first live draft added an example hex value the thread never mentioned, which a later session then repeated; the drafting prompt now forbids details not in the thread (3 of 3 re-drafts clean).
- [x] **2.6 Deep-dive agent.** Weekly: read the week's accepted entries, merge near-duplicates, raise conflicts, retire stale ones. *Done when:* it correctly merges two seeded duplicates. **Status:** `homeostat deep-dive` merges accepted near-duplicate pairs into the higher-scoring entry (scope union, `supersedes`, the other retired; Claude writes the combined text, `--no-llm` keeps the survivor's), asks Claude whether entries added or confirmed this week contradict overlapping accepted ones (both become `disputed`), retires entries unconfirmed for `agents.deepDive.staleAfterDays` (180), and opens one PR. Merging the seeded pair is verified in tests and with the real binary; the Claude parts are tested with stubs only. `init` schedules it weekly.
- [ ] **2.7 Export.** `export` writes accepted entries into `.claude/rules/`, `.cursor/rules/`, `AGENTS.md` and `.github/copilot-instructions.md`, one file per area, with a generated-file header. *Done when:* Cursor and Copilot pick up a rule without configuration. **Status:** built; Cursor and Copilot not yet confirmed. `homeostat export --kb <kb> --out <code repo>` writes `.claude/rules/homeostat/<area>.md` (`paths`), `.cursor/rules/homeostat/<area>.mdc` (`globs`, `alwaysApply`), `.github/instructions/homeostat/<area>.instructions.md` (`applyTo`), and marked blocks in `.github/copilot-instructions.md` (always-on rules, the only file github.com Chat reads) and `AGENTS.md`, keeping hand-written content and removing stale files only in homeostat's own folders; `--check` for CI. Formats follow each tool's docs as of 2026-10-13. Verified live in Claude Code (core rule at launch, area rule once a matching file is read); Cursor and Copilot need a manual check.
- [x] **2.8 End-to-end check.** On a fresh repo: init, leave a review comment, merge the fix, run the curator, approve the entry, start a Claude Code session, confirm the rule is applied. This becomes the demo script. *Done when:* the whole loop runs in under ten minutes by hand. **Status:** script in [demo.md](demo.md). Rehearsed locally without the curator (init, validate, learn, codeowners, export), and step 6 run live: with the plugin, a fresh session wrote `var(--color-*)` instead of hex for a new file and flagged an old hex value. Run end to end on 2026-10-13 in 5 min 4 s, the reviewer's step by hand in the browser: the new session wrote `var(--color-primary)` for a new file, named the rule, and flagged an older hex value. The KB repo's generated validate check fails until homeostat is on npm (E404), so the KB PR was validated locally.

## Phase 3 — MCP server (weeks 5–6)

- [x] **3.1 Tools.** `search`, `context` (same selection logic as the hook), `learn`, `explain` (why a rule exists, with source link), `flag` (dispute an entry), `report` (KB health). *Done when:* each tool has a test and a description under 200 characters. **Status:** `homeostat mcp` (package `@homeostat/mcp`, SDK 1.32 low-level server); `search` is local BM25 keyword ranking, `context` reuses the hook's selection, `learn`/`flag` commit to `candidates/<member>`; tested through a real client over in-memory and stdio transports.
- [x] **3.2 Unknown-call logging.** Log every tool name the model attempts that doesn't exist; surface it in the dashboard as a desire path. *Done when:* a fake call shows up in the log. **Status:** unknown tools are logged (`mcp-unknown-tool`) and answered with the tool list and closest match; common guesses (`get_rules`, `remember`, `list`, argument spellings like `q`, `entry_id`) are accepted and logged as `mcp-alias`. The dashboard surfaces both (Phase 4).
- [ ] **3.3 Cross-client check.** *Done when:* Claude Desktop and Cursor both list the server and `search` returns results. **Status:** verified live in Claude Code through the plugin (`mcp__plugin_homeostat_homeostat__search` returned the right entry); Claude Desktop and Cursor configs are in `packages/mcp/README.md` and need a manual check.

## Phase 4 — Dashboard (weeks 6–9)

- [x] **4.1 Event log.** SQLite file inside the KB repo (git-ignored) by default, one table of events: agent runs, entries created/accepted/retired, injections, tool calls. Every agent and hook writes to it. *Done when:* a day of use produces a readable log. **Status:** `.homeostat/events.db` through Node's built-in `node:sqlite` (no dependency; WAL, busy timeout), git-ignored. Written by the session-start and Stop hooks, the MCP server (calls, guessed names, injections), `learn`, `flag` and agent runs (including failures); `homeostat events` prints one line per event. The earlier `events.jsonl` is imported once.
- [x] **4.2 Setup pages.** Team and members, repos and sources, scoring rules, agent schedules, distribution, notifications: each a form that writes back to `<name>.yaml` with validation. *Done when:* every config key is editable without touching YAML. **Status:** forms for all seven sections (row editors for members and areas); a test walks the config schema and fails if any of its 35 keys lacks a field. Saves keep YAML comments, are validated with the CLI's own `parseConfig` first, and are refused (nothing written) when invalid.
- [x] **4.3 Metrics pages.** Agent liveness (last run, next run, failures), per-member contributions (entries, accepted ratio; framed as input to the shared KB, visible to all), KB health (entries by status, average age, open conflicts), repo view (coverage by path), impact (injections per session, rules applied). *Done when:* all five render from the event log. **Status:** overview (stability dial, KB health, agent liveness with last/next run and failures), members (alphabetical, no ranking, per the design doc), coverage (accepted rules per area, gaps, source repos), impact (injections and MCP calls per day, top rules, tool use), plus desire paths and the raw event log. Charts are inline SVG following the dataviz rules (single series, hover tooltips, table view, light and dark), checked in screenshots.
- [x] **4.4 Local-first.** `up` serves it on localhost; Docker image as the second option. No auth in v1 because it is local. *Done when:* `up` opens the dashboard with live data in one command. **Status:** `homeostat up` serves it on localhost:4747 next to the agent scheduler (`homeostat dashboard` serves it alone); the Docker image runs `up` and was verified through a port mapping. It binds to loopback, sends no external requests (strict CSP, no web fonts), and its forms carry a per-run token with Host/Origin checks against cross-site and DNS-rebinding requests.

## Phase T — Trust and data security (before any real team connects)

Plan and threat model: [security.md](security.md). Ordered by risk.

- [x] **T1 Guarded auto-merge.** A KB PR merges without a reviewer only when every entry in it reaches the threshold, is human-originated `pr-feedback` with a code change, passes validation and the T2/T3 scanners, and is in `scoring.autoMerge` scope (`enabled`, `areas`, `maxPerRun`); everything else needs a CODEOWNERS approval, set up by `init` as branch protection. Auto-merged entries are labelled and listed in the digest. *Done when:* tests show an agent-written, flagged-by-scanner, out-of-scope or below-threshold entry is never auto-merged, and a clean human-originated one is. — *Status:* `autoMergeDecision`/`splitAutoMerge` in core; `scoring.autoMerge {enabled, areas, excludeAreas, maxPerRun}` in config and the dashboard; `mergePullRequest` (squash) on both providers; the curator opens an auto-merge PR and a review PR, validates the whole merged KB before merging, and leaves the PR open if the host refuses; `auto-merged` events; `init` prints branch-protection and bypass guidance. Deep-dive and candidate PRs never auto-merge.
- [x] **T2 Secret scanner.** CPU-only detection of known token formats, private keys, credentialed URLs and high-entropy strings. It redacts review threads before they reach a model, errors in `validate`, and refuses `learn`, `flag` and handoff notes that contain secrets. *Done when:* a seeded token in a review comment never appears in a prompt or a committed entry, and tests cover each format. **Status:** `scanSecrets`/`redactSecrets` in core (13 token formats plus an entropy check that ignores hex SHAs and UUIDs); the curator redacts threads and PR titles before drafting; `validate` errors on secrets and warns on emails; `learn`, handoff notes and `flag` are refused before anything is committed.
- [x] **T3 Risky-content linter.** Flags entries that tell agents to run piped shell, contact unlisted URLs, touch credentials or environment variables, disable security checks, or use injection phrasing or hidden text; such entries need a recorded override. Agent-written candidates are labelled in their PRs. *Done when:* a poisoned review comment produces a PR that `validate` blocks. — *Status:* `risk.ts` (pipe-to-shell, unlisted URLs, credential handling, disabling security, injection phrasing, destructive commands, hidden characters and comments) runs on title and body in `validate`; override is `riskReviewedBy: <member>`; `security.allowedDomains` in config and the dashboard; provenance check for `pr-feedback` URLs; the curator keeps risky drafts as candidates and lists findings in the PR; candidate PRs say they are agent-written; the session header says rules never override safety. `packages/cli/test/risk-flow.test.ts` is the done-when.
- [ ] **T4 Pinned, signed releases.** The plugin launcher, skills and CI templates call an exact version, never `@0`; releases publish from Actions with npm provenance; Renovate and `pnpm audit` in CI; an SBOM per release. *Done when:* no floating version remains, and a release shows provenance on npm. — *Status:* built, awaiting the first release. One version everywhere via `scripts/version.mjs` (now 0.1.0), with `versions.test.ts` failing on drift or any floating `homeostat@` range; the plugin launcher's npx fallback reads the plugin's own version; `init` writes the exact version into CI; published packages run the compiled `dist/` (checked by packing, installing and running `validate`, `list` and the MCP handshake from the tarballs); `release.yml` publishes with trusted publishing and provenance and attaches a CycloneDX SBOM; Renovate with a three-day cooldown; `pnpm audit` in CI; pnpm `minimumReleaseAge`. Remaining, yours: make the repo public, reserve the npm names, add trusted publishers, push the first tag (see [releasing.md](releasing.md)).
- [x] **T5 Data controls.** `sources.exclude` (repos and paths), a `homeostat:skip` PR label, member opt-out, `curate --dry-run --show-prompts`, every model call logged by kind and size (never content), event-log retention. *Done when:* an excluded path's comments are never read, and a dry run prints every prompt that would be sent. — *Status:* `sources.exclude {repos, paths}`; the `homeostat:skip` marker (GitHub label, title or description; Bitbucket title or description); `optOut` per member (their PRs and review comments are never read); all checked before anything reaches a model. `curate --show-prompts` prints every prompt and sends none. Each model call logs a `model-call` event (agent, runtime, model, characters; never content). Local events are pruned after `security.eventRetentionDays` (90) at session start and on curator runs. All editable in the dashboard.
- [ ] **T6 Cloud model runtimes.** Amazon Bedrock and Google Vertex AI next to the API and Claude Code runtimes, so data stays in the team's own cloud account. *Done when:* the curator drafts through each with only cloud credentials. — *Status:* `agents.runtime: bedrock | vertex` with `agents.bedrock.region` and `agents.vertex {projectId, region}`, in the config and the dashboard. `AnthropicBedrockMantle` and `AnthropicVertex` are optional peer dependencies, loaded only when chosen, so the default install stays small. Both clouds use one forced tool call for structured answers (Bedrock's Messages endpoint has no structured outputs) and send no `fallbacks`. Bedrock model ids get the `anthropic.` prefix. Tested with stub clients and real SDK construction; not yet run against a live AWS or Google account. See [runtimes.md](runtimes.md).
- [ ] **T7 Visibility and export guards.** Per-area `visibility: team | org`; team-only areas are never exported and only injected for their members; `export` refuses public repos without `--allow-public`; MCP writes are off unless enabled, and rate-limited. *Done when:* tests prove a team-only rule never reaches another team's session or a public repo.
- [ ] **T8 Trust package.** `docs/data-handling.md` (one page: what is read, what leaves, where, how to turn each off), `SECURITY.md` with private reporting, and `homeostat doctor --security` (token scopes, branch protection, KB visibility, pinned versions, model runtime, exclusions, retention). *Done when:* a security reviewer can answer the four questions in security.md from those three alone.

## Phase K — Knowledge documents and cross-team memory (pilot parity)

Design: [knowledge-docs.md](knowledge-docs.md).

- [ ] **K1 Documents.** `knowledge/<area>/docs/<topic>.md`, `##` sections with stable ids and per-section provenance; validation for duplicate headings and ids, stray fences, section length, and the T2/T3 scanners. *Done when:* the pilot's topic documents convert and validate, and their known defects are caught.
- [ ] **K2 Kinds and decisions.** An optional `kind` on rules, grouped in injected context with one line of guidance each; `kind: decision, adopted: false` kept as context and never injected as a rule. *Done when:* a rejected proposal shows in `explain` and `search` but never in a session's rules.
- [ ] **K3 Teams.** A `teams` config key (members and owned areas) and teams on `sources.repos`; CODEOWNERS from teams; org-wide reads stay the default. *Done when:* one team's rule reaches another team's session that touches the same paths, and only the owning team can approve its changes.
- [ ] **K4 Agents keep documents current.** Section-level patches with provenance from the curator, the deep dive (evidence-cited refreshes, coverage gaps) and `learn --doc`, all by PR. *Done when:* a merged review thread that renames a service produces a correct one-section patch, and no run ever rewrites a whole document.
- [ ] **K5 Seeding.** `homeostat seed <repo>`, manual and opt-in only, drafts the first documents as one PR each, with `--dry-run` and exclusions. *Done when:* seeding a sample repo yields valid documents with provenance.
- [ ] **K6 Documents reach agents.** A relevant-documents index plus the most relevant sections at session start, within budget; MCP `docs` and `read`; export writes a `CLAUDE.md` block with `@imports` and Cursor and AGENTS.md equivalents. *Done when:* a session touching an area can read that area's architecture section without being told where it is.
- [ ] **K7 Usage and decay for sections.** Per-section reads on the dashboard; sections unread and unconfirmed for 90 days become review candidates. *Done when:* the dashboard shows section usage from the event log.
- [ ] **K8 Weekly digest.** New and changed rules, updated sections, review queue, flags and top desire paths, posted from CI to the webhook in `slackWebhookEnv`. *Done when:* a test channel receives a correct digest.

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
- `tokens` matches the recomputed count. A mismatch is a *fixable* warning: `homeostat validate --fix` rewrites it, so CI fixes it rather than failing.

### Open points for review

- [x] ~~Is `vertical` the right word publicly, or `area` / `domain`?~~ **Decided:** `area` (field, folder, config key `areas`).
- [ ] Should `scope` also allow language or framework selectors (`lang:ts`), or paths only for v1?
- [ ] Do we want a `confidence` separate from `score`, or is score enough?
- [ ] Write three real pilot entries in this format and see what breaks.

## Decisions log

Session 1 (2026-10-13), agreed before Phase 1 code:

- **Name (0.1):** Homeostat, chosen 2026-10-13 from a feedback-loop shortlist (Ashby's homeostat: a machine that keeps itself stable). npm `homeostat` was free; the bare GitHub name is held by an existing account, so the code lives at `ysugarmen/homeostat` and a public org would need a suffix. Not yet reserved: npm package, npm org scope `@homeostat`, domain.
- **Provider order:** Bitbucket first, GitHub second.
- **`detectConflicts()` is deterministic** (pure, no LLM): duplicate ids, `supersedes` cycles or dangling targets, one-sided `conflictsWith` links, and accepted entries with overlapping scope and near-identical titles. Semantic contradictions are the deep-dive agent's job (2.6).
- **Approval** is recorded as an optional `approvedBy` field, so `validate()` stays pure.
- **Token counts** use `js-tiktoken` (`cl100k_base`) as an approximation; good enough for budgeting, documented as approximate.
- **Tooling:** Biome for lint and format; `typescript` and `@types/node` as dev dependencies.
- **Claude API (2.5):** the agents use `@anthropic-ai/sdk` (approved 2026-10-13) with structured outputs and the default refusal fallback. Model and effort are per agent in `homeostat.yaml` (`agents.curator.model`, default `claude-opus-5-5`, effort `medium`).
- **Claude runtime (2.5, revised twice):** `agents.runtime` picks how the agents reach Claude. `api` is the default: Anthropic's Consumer Terms limit a personal Free/Pro/Max subscription to non-commercial use, forbid sharing its credentials, and the Claude Code docs say products must use API keys and recommend a Console key for shared CI secrets. `claude-code` is opt-in, for personal use or a Team/Enterprise plan; it runs a bare `claude -p` (own system prompt, no tools, MCP, skills or settings: about 1k input tokens per call) with whatever Claude Code is logged in with (in CI a `claude setup-token` token as `CLAUDE_CODE_OAUTH_TOKEN`). `api` uses `@anthropic-ai/sdk` with a Console key. The homeostat hooks skip calls made with `HOMEOSTAT_AGENT=1`.
- **Trust and documents (2026-10-14):** guarded auto-merge stays (security plan T1); Bedrock and Vertex runtimes are added; MCP write tools are off by default; documents live in `knowledge/<area>/docs/`; `seed` is manual and opt-in; the digest is Slack only to start.
- **CODEOWNERS (1.5):** members get an optional `handle` (`@user`, `@org/team` or an email), because member ids are not platform identities. Seniors own `*` and `homeostat.yaml`; members listing an area own `knowledge/<area>/` (seniors if nobody does); an entry owner outside the area gets a line for that entry. `homeostat codeowners --check` lets CI catch a stale file.

## Working agreement

One step per session, in order, unless a dependency says otherwise. For each step I draft the artefact (schema, code, config, doc), you review, and we verify the *done when* test together before ticking the box.

**Start here:** 1.2, the entry schema. It needs no name and no sign-off, and every other step depends on it.
