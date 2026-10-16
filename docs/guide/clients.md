# Using it from your tools

## Claude Code plugin

```sh
claude plugin marketplace add ysugarmen/homeostat
claude plugin install homeostat@homeostat
```

Set the plugin's `kb_dir` to your local clone of the KB repo. Then:

- **At session start**, the hook adds the accepted rules for the files you are touching (grouped by kind, within `distribution.tokenBudget`), and an index of the team documents that cover them, with the sections that name your files.
- **At the end of a session with real edits**, the agent is asked once for a handoff note: what to do next time, and what was tried and rejected. The note is saved as a pending lesson: it applies to your sessions at once, and the next daily run decides it for the team.
- **Skills:**
  - `/homeostat:learn` captures a rule or a document section from the session or a review comment.
  - `/homeostat:explain <file or id>` says which rules apply and why.
  - `/homeostat:review` walks the review queue with you.

## MCP (any agent)

`homeostat mcp` serves the KB over stdio. It finds the KB from `HOMEOSTAT_DIR`.

| Tool | What it does |
| --- | --- |
| `context` | The rules for given files, best first, within a budget |
| `search` | Keyword search over accepted rules (and rejected decisions, shown as context) |
| `explain` | Why a rule exists: source, score breakdown, owner, conflicts |
| `docs` | The team's documents and their sections, for an area or a file |
| `read` | One document, or one section, with its source |
| `report` | KB health over recent days |
| `learn`, `flag` | Only when `security.mcpWrites` is on; capped per session |

Claude Desktop, Cursor and others:

```json
{
  "mcpServers": {
    "homeostat": {
      "command": "npx",
      "args": ["--yes", "homeostat@0.1.2", "mcp"],
      "env": { "HOMEOSTAT_DIR": "/path/to/your/kb-checkout" }
    }
  }
}
```

## Exported rules files

From a code repo, run `homeostat export --kb ../team-kb`. It writes each tool's native format: the area's rules and documents, scoped to their paths.

| Tool | Files |
| --- | --- |
| Claude Code | `.claude/rules/homeostat/` (`paths:` frontmatter) |
| Cursor | `.cursor/rules/homeostat/*.mdc` (`globs`) |
| Copilot | `.github/instructions/homeostat/` (`applyTo`), plus a block in `.github/copilot-instructions.md` |
| AGENTS.md | A marked block, and documents under `.agents/homeostat/` |

How export behaves:
- Run it in the code repo's CI with `--check` to fail when the files are out of date.
- Team-only areas are never exported.
- It refuses a public repo unless you pass `--allow-public`.

## Terminal

`homeostat search`, `explain`, `list`, `status` and `events` read the KB. Add `--json` for agents.
