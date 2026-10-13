# kbx

Turn accepted code-review feedback into scored, governed team knowledge that every coding agent can use.

> Early development, private. The design and the live plan are in [`docs/design.md`](docs/design.md) and [`docs/execution-plan.md`](docs/execution-plan.md); the end-to-end demo is [`docs/demo.md`](docs/demo.md).

## How it works

1. **Capture.** A daily curator reads merged PRs, keeps review comments that were followed by a code change, and drafts one entry each with Claude. Developers add entries with `kbx learn` or `/kbx:learn`, and sessions leave handoff notes.
2. **Govern.** Every entry is scored (+3 accepted PR feedback, +2 manual, +1 senior author, −2 conflict) and lands through a PR on the knowledge-base repo, where CODEOWNERS and the auto-merge threshold decide who approves it. A weekly deep dive merges duplicates, marks contradictions and retires stale entries.
3. **Distribute.** The Claude Code plugin injects the entries relevant to the files you are touching at session start, within a token budget. `kbx export` writes the same entries as Claude, Cursor, Copilot and AGENTS.md rules files.

Nothing scheduled runs on a laptop: the agents run in the KB repo's CI (or `kbx up` on a shared box).

## Commands

| Command | What it does |
| --- | --- |
| `kbx init` | Scaffold `kbx.yaml`, `knowledge/` and the CI jobs (validate on PRs, daily curator, weekly deep dive) in a KB repo |
| `kbx validate [--fix]` | Check the config and every entry; `--fix` rewrites stale scores and token counts |
| `kbx learn [comment-url]` | Write one candidate entry from flags, prompts or a PR review comment |
| `kbx codeowners [--check]` | Generate CODEOWNERS from members, areas and entry owners |
| `kbx curate` | The curator run (CI) |
| `kbx deep-dive` | The deep-dive run (CI) |
| `kbx export --out <repo>` | Write accepted entries into a code repo as each tool's rules files |
| `kbx up` | Run the curator and deep dive on their schedules from a shared box |

The Claude Code plugin is in [`packages/plugin`](packages/plugin).

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Entry schema, config, scoring, validation, providers (Bitbucket, GitHub), curator, deep dive, export |
| `packages/cli` | The `kbx` command and the plugin's hook handlers |
| `packages/plugin` | Claude Code plugin: skills and hooks |
| `packages/mcp` | MCP server (Phase 3, not started) |
| `packages/dashboard` | Dashboard (Phase 4, not started) |
| `examples/starter-kb` | A small example knowledge base |

## Development

```sh
pnpm install
pnpm check   # lint + typecheck + tests
```

## Licence

[Apache-2.0](LICENSE).
