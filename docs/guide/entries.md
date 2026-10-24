# Rules and documents

The knowledge base holds two kinds of knowledge, both as Markdown under `knowledge/`:

- **Rules**: short, scored instructions, matched to the files an agent touches. Each is its own file, or a section of a topic file.
- **Documents**: the team's living reference (architecture, contracts, migrations), in sections agents read on demand.

`homeostat validate` checks both; CI runs it on every pull request. The JSON Schema for rule frontmatter is [`packages/core/schema/entry.schema.json`](https://github.com/ysugarmen/homeostat/blob/main/packages/core/schema/entry.schema.json), for editor completion.

## Where they live

| Layout | Rules | Documents |
| --- | --- | --- |
| One code repo | `knowledge/<area>/<id>.md` | `knowledge/<area>/docs/<topic>.md` |
| With `topics` | `knowledge/<area>/<topic>.md`, one section per rule | same |
| Several repos (`repos`) | `knowledge/<repo>/<area>/…`, shared ones in `knowledge/core/` | `knowledge/<repo>/<area>/docs/<topic>.md` |

Areas in a multi-repo KB are named `<repo>/<area>` everywhere else (member areas, `--area`). [Moving to 0.2](migrating.md) covers moving an existing KB.

## Rules: `knowledge/<area>/<id>.md`

```markdown
---
id: outbound-http-retry-helper
title: Use the shared retry helper for outbound HTTP calls
area: integrations
scope: ["services/integrations/**"]
status: accepted
score: 4
owner: dana
source:
  type: pr-feedback
  url: https://github.com/acme/api/pull/812#discussion_r33
  author: dana
  changedCode: true
created: 2026-09-30
lastConfirmed: 2026-10-07
tags: [http, resilience]
tokens: 144
---

## Rule
Wrap every outbound HTTP call to a partner API in `withRetry()` from `@app/http-client`.

## Why
Partner APIs time out often; the helper adds backoff and the request-id header on-call searches by.

## Example
(optional: code showing wrong and right)
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase words joined by hyphens; matches the file name |
| `title` | Imperative, at most 80 characters |
| `area` | An area from `homeostat.yaml`, or `core` for everywhere |
| `scope` | Path globs in your code repos the rule applies to; `["**"]` for everything |
| `status` | `candidate` (proposed), `accepted` (in force), `disputed` (flagged back to review), `retired` |
| `score` | Computed from the source; `validate --fix` keeps it current |
| `owner` | The member who answers for it |
| `source` | `type` (`pr-feedback`, `manual`, `agent-handoff`, `deep-dive`), `url` (required for pr-feedback), `author`, `changedCode` (did the code change after the comment?) |
| `alsoFrom` | Optional: URLs of later lessons the daily run folded into this rule instead of adding a sibling. `source` stays the first origin; the curator treats these threads as already known |
| `created`, `lastConfirmed` | ISO dates; the deep dive retires rules not confirmed for `staleAfterDays` |
| `approvedBy` | Optional: who accepted it. Merging is the approval, so nobody needs to set it by hand |
| `kind` | Optional: `convention`, `anti-pattern`, `review-lesson`, `migration`, `legacy`, `tech-debt`, `practice`, `decision`. Sessions group rules by kind under one line of guidance each |
| `adopted` | With `kind: decision`: `false` records a proposal the team rejected. Agents see it in search and explain as context and stop re-proposing it, but never get it as a rule |
| `riskReviewedBy` | A member who read the risky-content findings (see below) and judged the rule safe |
| `conflictsWith`, `supersedes`, `tags`, `flags` | Links to other rules, search tags, and "this is wrong" reports (each costs score) |
| `tokens` | Cached token count of the body, for budgeting; `validate --fix` updates it |

The body has `## Rule` (at most 60 words), `## Why` (at most 100) and an optional `## Example`.

### Rules in a topic file: `knowledge/<area>/<topic>.md`

With a topic list in the config, rules that share a subject share a file:

```markdown
---
topic: migrations
title: Migrations
description: Alembic schema changes, backfills and their deploy order
---

## Keep million-row backfills out of schema migrations {#keep-million-row-backfills}
<!-- homeostat
status: accepted
score: 4
owner: sam
scope: ["services/db/**"]
source: { type: pr-feedback, url: "https://github.com/acme/api/pull/901#discussion_r7", author: sam, changedCode: true }
created: 2026-10-02
lastConfirmed: 2026-10-02
tokens: 37
-->

Run large backfills as a separate job after the schema migration deploys.

### Why
A backfill inside the migration held a lock for 40 minutes in production.
```

- The heading is the title and `{#id}` the id; the comment holds the other fields, without `id`, `title`, `area` or `topic`, which the file and heading give.
- `### Why` and `### Example` replace the `##` sections of a one-rule file.
- Sections are kept sorted by id; `validate` warns when they are not and fails on a duplicate id or a topic missing from the config.
- `learn --topic <topic>` picks the file (else a word match on the topic names, else `general`, which is always allowed); the daily run's drafter picks it from the list.

### Scoring

| Signal | Points |
| --- | --- |
| Review feedback followed by a code change | +3 |
| Written by a member by hand | +2 |
| Written by a senior | +1 |
| Conflicts with another rule | −2 |
| Each flag | −2 |

The score orders rules in a session when the token budget is tight. It does not decide what merges: the [daily run](agents.md#daily) gives each new lesson a separate 0–100 confidence, which also weighs the role of whoever vouches for it, and merges, declines or sends it to a reviewer by that.

### What validate refuses

- **Secrets:** cloud, code-host and package-registry tokens, API keys (AI, payment, messaging, commerce), Slack webhooks, private keys, JWTs, passwords, credentialed and database URLs and card numbers fail validation, so they cannot be merged. Emails are a warning; refer to people by member id.
- **Risky instructions:** a rule fails until a member sets `riskReviewedBy` if it tells agents to:
  - pipe a download into a shell
  - link to a domain outside `security.allowedDomains` (placeholder domains such as `*.example`, `localhost` and one-word service names are fine; each domain is reported once)
  - move or reveal credentials
  - turn off TLS, auth or signature checks
  - read like a prompt injection
  - run destructive commands
  - hide text in invisible characters or HTML comments
- **Unknown sources:** a `pr-feedback` URL must point at a repo in `sources.repos`.

## Documents: `knowledge/<area>/docs/<topic>.md`

```markdown
---
title: Partner API calls
area: integrations
owner: dana
scope: ["services/integrations/**"]
updated: 2026-10-12
---

How the integrations services talk to partner APIs.

## The shared HTTP client {#http-client}
<!-- homeostat: source=pr-feedback url=https://github.com/acme/api/pull/790#discussion_r41 updated=2026-10-12 confidence=high -->
Every outbound call goes through `withRetry()` from `@acme/http-client`.

## Timeouts {#timeouts}
<!-- homeostat: source=manual author=dana updated=2026-09-30 -->
Partner calls time out after 10 seconds; booking confirmation waits up to 30.
```

- Each `##` section has a stable `{#id}`, so it stays addressable when its heading changes, and a provenance comment saying where it came from and when.
- Agents and people change one section at a time (`homeostat learn --doc integrations/partner-calls --section timeouts --append --text "…"`), never the whole file.
- `validate` catches the damage whole-file rewrites cause:
  - duplicate headings or ids
  - repeated "Last updated" lines
  - code fences wrapping the whole file
  - conflict markers
  - sections over 400 words
- Bring existing Markdown in with `homeostat docs convert <files> --area <area> --owner <member>`, or draft a new team's first documents with [`homeostat seed`](agents.md#seed).
