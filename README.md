# Homeostat

**Your team's code-review lessons, as rules every coding agent follows.**

Your reviewers already teach your coding agents, one comment at a time: "use the retry helper", "never log the request body", "that service was renamed". Each agent forgets by the next session, so the same comment gets written again next week. Claude's own memory helps one person in one tool. It is unreviewed, and it is not shared with the rest of the team or with Cursor, Copilot and Codex.

Homeostat closes the loop:
- It turns review feedback that led to a code change into short, scored rules and living team documents.
- It keeps them in a git repo, one folder per code repo when a team owns several, with rules grouped into topic files. Every change arrives by pull request, and only the uncertain ones need a human.
- It gives every agent the ones that matter for the files it is touching.

<!-- demo.gif: render with `vhs docs/demo.tape` -->

## Get started

```sh
# In a clone of a new or existing repo for your team's knowledge base:
npx --yes homeostat@0.4.1 setup

# Then each developer, once, in their own clone (installs the Claude Code plugin):
npx --yes homeostat@0.4.1 setup --join
```

`setup` is a re-runnable checklist: it asks only for what is missing, checks each step with a real call, and stores the CI secrets for you ([every step](docs/guide/setup.md)). The [quickstart](docs/guide/quickstart.md) takes you from there to the first daily run in about ten minutes. The full guide starts at [docs/index.md](docs/index.md).

> 0.2 adds knowledge bases for several code repos, rules grouped into topic files, and `homeostat bootstrap`. Coming from 0.1: [moving to 0.2](docs/guide/migrating.md). How it works technically: [docs/architecture.md](docs/architecture.md).

## How it works

1. **Start.** `homeostat bootstrap` builds a first base for each repo from its checkout: its existing docs, plus documents on its architecture, conventions, database schemas and infrastructure, in one PR per repo to review.
2. **Capture.** Developers add lessons with `homeostat learn` or `/homeostat:learn`, and sessions leave handoff notes. A lesson applies to its author's sessions at once. Each morning a daily run in CI also reads merged PRs, keeps review comments that were followed by a code change, and drafts one rule each with Claude. It also proposes one-section updates to the team documents those comments affect.
3. **Govern.** The daily run packs each developer's lessons into one PR a day. It scores every lesson for confidence (its source, the role of whoever vouches for it, how specific it is, flags and conflicts) and decides. Confident lessons merge themselves, weak ones are declined, and the rest go to a review PR for the team's named reviewers (or the area's owners), mentioned in Slack when it is set up. Secrets and risky instructions never merge unreviewed. Developers' sessions sync in the background, with no laptop scheduler and no per-developer setup. The dashboard shows every decision, the review queue, and who is syncing. A weekly deep dive merges duplicates, marks contradictions and retires stale entries.
4. **Distribute.** The Claude Code plugin injects the rules relevant to the files you are touching at session start, within a token budget: the session's own repo's rules plus the shared ones, the document sections that name those files, and a short guide that counts the rest and says when to look things up and how to credit what was used. Every prompt gets a one-line reminder of it. Any agent can use the MCP server. `homeostat export` writes the same rules and documents as Claude, Cursor, Copilot and AGENTS.md files.

Nothing scheduled runs on a laptop: the agents run in the KB repo's CI (or `homeostat up` on a shared box).

## Commands

Every command also works under the short alias `homeo` (`homeo learn`, `homeo validate`, ...).

| Command | What it does |
| --- | --- |
| `homeostat setup [--check] [--step <name>] [--join]` | Guided, re-runnable setup of a team KB: checks each step, asks only for what is missing, verifies tokens and stores them as CI secrets; `--join` sets up a developer's machine |
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
| `homeostat metrics` | Performance metrics: decisions, calibration, review latency, reach and runtime (`--json` for scripts) |
| `homeostat eval` | Score rule selection against your cases in `eval/selection.yaml`: hits, MRR, nDCG and recall at 1, 3, 5 and 10, no model call (`--json`, `--min` floors for CI) |
| `homeostat bench run`, `bench report` | Before/after benchmark: the same tasks through headless Claude Code with the plugin off and on, under a `--budget`, resumable; compares accuracy, corrections, cost, time and turns (`--json` aggregates for a public page). Spends usage: see [the guide](docs/guide/bench.md) |
| `homeostat flag <id>` | Report that an entry is wrong: it loses score and goes back to review |
| `homeostat mcp` | Serve the KB to any agent over MCP (stdio) |
| `homeostat docs convert <file...>` | Bring existing markdown documents into `knowledge/[<repo>/]<area>/docs/`, with section ids and provenance; `# ` headings demoted and long sections split |
| `homeostat docs fix [--dry-run]` | Apply the same clean-up to the documents already in the KB |
| `homeostat bootstrap` | A first base for each repo: its existing docs, plus code, data and infrastructure documents drafted from its checkout (manual only; one PR per repo) |
| `homeostat seed <checkout>` | Draft first documents from one local repo (manual only: with `bootstrap`, the only commands that send code to a model) |
| `homeostat migrate` | Move a 0.1 KB into repo folders, and with `--topics` into topic files |
| `homeostat digest` | Post the weekly digest to Slack (CI) |
| `homeostat doctor --security` | Check a setup: what is read, what leaves, who can change the rules, the blast radius |

The Claude Code plugin is in [`packages/plugin`](packages/plugin).

## Security and data

The daily run reads review comments, never source code; only `bootstrap` and `seed`, run by hand after a preview, send code to a model. Secrets are redacted before any model call and fail validation, so they cannot be merged. A lesson merges unreviewed only above the confidence threshold and with no secret or risky-content findings; risky instructions always go to a human. Model calls can stay in your own AWS or Google Cloud account. [`docs/data-handling.md`](docs/data-handling.md) is the one-page answer for a security review, [`docs/security.md`](docs/security.md) is the threat model, and [`SECURITY.md`](SECURITY.md) explains how to report a vulnerability.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Entry schema, config, scoring, validation, providers (Bitbucket, GitHub), the daily run's drafting, deep dive, bootstrap, export |
| `packages/cli` | The `homeostat` command and the plugin's hook handlers |
| `packages/plugin` | Claude Code plugin: skills and hooks |
| `packages/mcp` | MCP server: context, search, explain, docs, read, report (and learn, flag when enabled) |
| `packages/dashboard` | Local dashboard: setup forms and metrics, server-rendered |
| `examples/starter-kb` | A small example knowledge base |
| `examples/starter-multi-kb` | The same, laid out for two code repos |

## Development

```sh
pnpm install
pnpm check   # lint + typecheck + tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE).
