# Homeostat

**Your team's code-review lessons, as rules every coding agent follows.**

Your reviewers already teach your coding agents, one comment at a time: "use the retry helper", "never log the request body", "that service was renamed". Each agent forgets by the next session, so the same comment gets written again next week. Claude's own memory helps one person in one tool. It is unreviewed, and it is not shared with the rest of the team or with Cursor, Copilot and Codex.

Homeostat closes the loop:
- It turns review feedback that led to a code change into short, scored rules and living team documents.
- It keeps them in a git repo. Every change arrives by pull request, and only the uncertain ones need a human.
- It gives every agent the ones that matter for the files it is touching.

<!-- demo.gif: render with `vhs docs/demo.tape` -->

## Get started

```sh
# In a new or existing repo for your team's knowledge base:
npx --yes homeostat@0.1.9 init

# In Claude Code, on each developer's machine:
claude plugin marketplace add ysugarmen/homeostat
claude plugin install homeostat@homeostat
```

The [quickstart](docs/guide/quickstart.md) takes you from there to the first daily run in about ten minutes. The full guide starts at [docs/index.md](docs/index.md).

> Early days: 0.1.0 is the first release. How it works technically: [docs/architecture.md](docs/architecture.md). The market research and live plan are in [docs/design.md](docs/design.md) and [docs/execution-plan.md](docs/execution-plan.md).

## How it works

1. **Capture.** Developers add lessons with `homeostat learn` or `/homeostat:learn`, and sessions leave handoff notes. A lesson applies to its author's sessions at once. Each morning a daily run in CI also reads merged PRs, keeps review comments that were followed by a code change, and drafts one rule each with Claude. It also proposes one-section updates to the team documents those comments affect.
2. **Govern.** The daily run packs each developer's lessons into one PR a day. It scores every lesson for confidence (its source, the role of whoever vouches for it, how specific it is, flags and conflicts) and decides. Confident lessons merge themselves, weak ones are declined, and the rest go to a review PR for the area's owners. Secrets and risky instructions never merge unreviewed. Developers' sessions sync in the background, with no laptop scheduler and no per-developer setup. The dashboard shows every decision, the review queue, and who is syncing. A weekly deep dive merges duplicates, marks contradictions and retires stale entries.
3. **Distribute.** The Claude Code plugin injects the rules relevant to the files you are touching at session start, within a token budget, plus an index of the documents that cover them. Any agent can use the MCP server. `homeostat export` writes the same rules and documents as Claude, Cursor, Copilot and AGENTS.md files.

Nothing scheduled runs on a laptop: the agents run in the KB repo's CI (or `homeostat up` on a shared box).

## Commands

Every command also works under the short alias `homeo` (`homeo learn`, `homeo validate`, ...).

| Command | What it does |
| --- | --- |
| `homeostat init` | Scaffold `homeostat.yaml`, `knowledge/` and the CI jobs (validate on PRs, the daily run, weekly deep dive) in a KB repo |
| `homeostat validate [--fix]` | Check the config and every entry; `--fix` rewrites stale scores and token counts |
| `homeostat learn [comment-url]` | Save one lesson from flags, prompts or a PR review comment; it applies to your sessions now and goes to tomorrow's daily run |
| `homeostat codeowners [--check]` | Generate CODEOWNERS from members, areas and entry owners |
| `homeostat daily` | The daily run (CI): one scored PR per developer, merged, declined or sent to a reviewer |
| `homeostat review list`, `show`, `merge`, `close`, `comment` | Work the review queue on GitHub or Bitbucket: merge a review PR to accept its lessons, close it to decline them |
| `homeostat sync` | Pull the team KB and send your pending lessons (the plugin runs it in the background) |
| `homeostat curate` | Draft rules from review comments on their own, without the daily decisions |
| `homeostat deep-dive` | The deep-dive run (CI) |
| `homeostat export --out <repo>` | Write accepted entries into a code repo as each tool's rules files |
| `homeostat up` | Serve the dashboard and run the daily run and deep dive on their schedules (a shared box; also the Docker image) |
| `homeostat dashboard [--build <dir>]` | Serve just the dashboard on localhost:4747, or build a shared read-only copy for CI to publish |
| `homeostat search`, `explain`, `list`, `status` | Read the KB from the terminal (`--json` for agents) |
| `homeostat events` | The local event log, one line per event |
| `homeostat flag <id>` | Report that an entry is wrong: it loses score and goes back to review |
| `homeostat mcp` | Serve the KB to any agent over MCP (stdio) |
| `homeostat docs convert <file...>` | Bring existing markdown documents into `knowledge/<area>/docs/`, with section ids and provenance |
| `homeostat seed <checkout>` | Draft a team's first documents from a local repo (manual only: the one command that sends code to a model) |
| `homeostat digest` | Post the weekly digest to Slack (CI) |
| `homeostat doctor --security` | Check a setup: what is read, what leaves, who can change the rules, the blast radius |

The Claude Code plugin is in [`packages/plugin`](packages/plugin).

## Security and data

The curator reads review comments, never source code. Secrets are redacted before any model call and fail validation, so they cannot be merged. A lesson merges unreviewed only above the confidence threshold and with no secret or risky-content findings; risky instructions always go to a human. Model calls can stay in your own AWS or Google Cloud account. [`docs/data-handling.md`](docs/data-handling.md) is the one-page answer for a security review, [`docs/security.md`](docs/security.md) is the threat model, and [`SECURITY.md`](SECURITY.md) explains how to report a vulnerability.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Entry schema, config, scoring, validation, providers (Bitbucket, GitHub), curator, deep dive, export |
| `packages/cli` | The `homeostat` command and the plugin's hook handlers |
| `packages/plugin` | Claude Code plugin: skills and hooks |
| `packages/mcp` | MCP server: context, search, explain, docs, read, report (and learn, flag when enabled) |
| `packages/dashboard` | Local dashboard: setup forms and metrics, server-rendered |
| `examples/starter-kb` | A small example knowledge base |

## Development

```sh
pnpm install
pnpm check   # lint + typecheck + tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE).
