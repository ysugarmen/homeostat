# Knowledge documents and cross-team memory: pilot parity plan

> **Historical.** Written while building 0.1 (October 2026) and kept as the record of how Homeostat was planned. For how it works today, see [architecture.md](architecture.md) and the [guide](index.md); where they disagree with this page, they win.

**Status:** draft for review, 2026-10-14. The plan is Phase K in [execution-plan.md](execution-plan.md).

Homeostat today holds one kind of knowledge: **atomic rules**. Each is one short, scored, reviewed instruction, matched to the files an agent touches. The pilot held mostly something else: **topic documents**, the team's living reference of how the system works. That includes architecture maps, service catalogs, cross-repo contracts, migrations in progress, legacy-to-replacement notes, tech-debt registers and domain guides, kept current by agents. That is the part teams lean on most, and the part to bring back.

## Why not rely on Claude's built-in memory

Claude Code's memory (auto-memory, CLAUDE.md, team memory sync) is useful, and Homeostat works alongside it. But it is:

- **Per tool.** Cursor, Copilot and Codex agents do not see it.
- **Unreviewed.** Anything written is in force.
- **Not team-structured.** There are no layers, owners or cross-team visibility rules.
- **Not evidence-linked.** Nothing says where a line came from or whether it is still true.

Homeostat's documents are git files with owners, provenance, review and scoring, delivered to every agent. That is the difference worth building on.

## What the pilot had, and how Homeostat will carry it

| Pilot feature | Homeostat today | Plan |
| --- | --- | --- |
| Topic documents (architecture, conventions, cross-repo, domain, integrations, migrations, legacy, tech debt, stack practices) | None | **K1:** documents as a second kind of knowledge |
| Rule kinds (convention, anti-pattern, review lesson, migration, legacy, tech debt, practice) | One kind | **K2:** an optional `kind` field, with per-kind guidance for agents |
| Layers: core vs team, write per team, read by all (team.json) | Areas, member areas, generated CODEOWNERS | **K3:** teams as a first-class config key; areas map to teams |
| Cross-team visibility (everyone reads everything) | Every session gets the rules whose scope matches its files, whichever team wrote them ✅ | **K3:** keep; add per-area `visibility` (security plan T6) |
| Repo-to-team mapping | `sources.repos` without teams | **K3:** `sources.repos[].teams` |
| "Discussed, not adopted" kept as context | Not represented | **K2:** `kind: decision` with `adopted: false`; never injected as a rule, shown as context |
| Per-entry provenance (EVIDENCE tags) | Per-entry source link ✅ | **K1:** per-section provenance in documents |
| Agents update the docs (curator appends or replaces sections; weekly deep dive refreshes) | Curator writes new rules only | **K4:** section-level document edits by the curator and deep dive |
| Seeding from a scan of each repo | None | **K5:** `homeostat seed`, opt-in, because it sends code to a model |
| Docs reaching sessions (CLAUDE.md block listing files; review bot loads all) | Rules injected by path ✅ | **K6:** a document index injected; sections on demand through MCP and `@imports` |
| Usage and decay signals (designed, never produced data in the pilot) | Injection counts per rule ✅ | **K7:** usage per document section; decay for unused sections |
| Daily and weekly Slack digests | Config only (`notifications`) | **K8:** the weekly digest |
| Heartbeats, Grafana, installer on every laptop | Dashboard, no laptop daemons ✅ | Not carried over: per-laptop daemons are what the zero-maintenance constraint rules out |

## K1. Documents as a second kind of knowledge

- **Location:** `knowledge/<area>/docs/<topic>.md` (core documents in `knowledge/core/docs/`). They are validated, but not as atomic entries.
- **Shape:**
  - frontmatter with `title`, `area`, `owner`, `scope` (the paths it describes), `updated`
  - then `##` sections, each with a stable id and provenance in one machine-readable comment, e.g.

    ```markdown
    ## Service-to-service calls {#service-calls}
    <!-- homeostat: source=pr-feedback url=https://… updated=2026-10-12 confidence=high -->
    Internal services call each other through the shared client …
    ```
  - the `{#id}` keeps a section addressable when its heading changes
- **Validation**, which fixes the pilot's real bugs:
  - unique section ids and headings
  - no repeated `updated` lines
  - no code fences wrapping the whole file
  - the secret and risky-content scanners from the security plan
  - a per-section length budget

## K2. Kinds of rule, and decisions not adopted

- Rules gain an optional `kind`: `convention | anti-pattern | review-lesson | migration | legacy | tech-debt | practice | decision`.
- The injected context groups rules by kind, with one line of guidance per kind, e.g. "migration: check before touching this area".
- `kind: decision` with `adopted: false` records a proposal the team discussed and rejected, and why. It is never injected as an instruction. `explain` and `search` show it as context ("we considered X and chose not to, because …"), which stops agents re-proposing it.

## K3. Teams and cross-team memory

- **Config:** a `teams` key (team id → members and the areas it owns), and `sources.repos` entries that may name the teams that work on them.
- **Writes:** CODEOWNERS is generated from teams, so each team approves changes to its own areas and documents, and seniors approve core.
- **Reads:** stay org-wide by default. A session gets every rule and document section whose scope matches what it is touching, whichever team wrote it. That *is* the cross-team memory: the integrations team's lesson reaches the frontend developer who edits the same client.
- **Exception:** areas listed in `security.teamOnlyAreas` (security plan T7).

## K4. Agents keeping documents current

Edits are section-level patches, never whole-file rewrites. Whole-file rewrites caused most of the pilot's damage: duplicated headings, lost sections, conflict markers.

- **Curator.** After drafting rules, it asks whether a review thread changes a document section (a renamed service, a finished migration). If so, it proposes a section patch with provenance in the same PR.
- **Deep dive.**
  - Re-reads each document section against the code paths in its scope and proposes updates only for sections it can show are out of date, citing the evidence.
  - Leaves sections with fresh provenance alone.
  - Flags coverage gaps (areas with code but no document).
- **People and agents in a session.** `/homeostat:learn` and MCP `learn` can target a document section (`--doc core/architecture --section service-calls`) as well as a new rule.
- **Review.** Everything is a PR, reviewed by the owning team, with no auto-merge (security plan T1).

## K5. Seeding a new knowledge base

`homeostat seed <repo>` drafts the first documents (architecture, conventions, cross-repo contracts) from a scan of a repository, as one PR per document.

- **Opt-in.** This is the one feature that sends **source code** to a model, so it is never scheduled. It runs only by hand, shows its prompts in `--dry-run`, and respects `sources.exclude`.
- It is the fastest way to give a new team value on day one, which the pilot's seed branches showed.

## K6. Getting documents to agents

Documents are too big to inject whole (the pilot found the same).

- **SessionStart** adds a short index: the titles of the documents relevant to the paths being touched, plus the MCP tool to read them. The full text of only the most relevant sections is added, within the token budget.
- **MCP** gains `docs` (list documents) and `read` (a document or one section by id).
- **Export:**
  - writes a marked block into `CLAUDE.md` that `@imports` the area documents for Claude Code
  - writes the same documents as Cursor rules with globs, and into `AGENTS.md` as links

## K7. Usage and decay

The injection and MCP read events already exist. Per-section read counts feed the dashboard and the deep dive: a section nobody has read in 90 days and nobody has confirmed becomes a review candidate, not an automatic deletion.

## K8. Weekly digest

Uses the existing `notifications` config: a weekly message with new and changed rules, document sections updated, the open review queue, flags, and the top desire paths. It is generated on the CPU from the KB and the event log, and posted from CI through the webhook named in `slackWebhookEnv`.

## Open decisions

All decided 2026-10-14: documents live in `knowledge/<area>/docs/`; `seed` is included, manual and opt-in only; the digest is Slack only to start.
