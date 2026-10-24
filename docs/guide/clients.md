# Using it from your tools

## Claude Code plugin

```sh
claude plugin marketplace add ysugarmen/homeostat
claude plugin install homeostat@homeostat
```

Set the plugin's `kb_dir` to your local clone of the KB repo. Then:

- **At session start**, the hook adds the accepted rules for the files you are touching, within `distribution.tokenBudget` and grouped by kind. In a multi-repo KB these are the session's own repo's rules plus the shared ones. The order is:
  1. rules scoped to those files
  2. general rules that name one of them
  3. other general rules

  Next come the document sections that name your files. Last is a short lookup guide: how many more rules apply (by topic) and how many documents cover the code (by area), deliberately without titles; which tool to call (`context`, `search`, `docs` then `read`, `explain`); the moments to look things up (a bug report, writing or changing a test, new code or making parts fit, a why or what's-left question, a commit); and the credit line `> From Homeostat (<rule-id or area/topic#section>)` to put above a part of the reply that used them. Listing titles up front made agents pick from the list instead of searching; a count and a named moment make the first call a search. On a very small `tokenBudget` the guide shrinks to its counts and one line.
- **On every message**, the hook adds a one-line reminder of those moments and the credit line (under 80 tokens), plus any rules that are new since the session started.
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
| `search` | Keyword search over accepted rules and document sections (rejected decisions shown as context): up to 10 hits by default, each with a one-line snippet and the id to open |
| `explain` | Why a rule exists: source, score breakdown, owner, conflicts |
| `docs` | The team's documents and their sections, for an area or a file |
| `read` | One section (`doc` and `section`, or `area/topic#section`), or a whole document, each section once, with its source |
| `report` | KB health over recent days |
| `learn`, `flag` | Only when `security.mcpWrites` is on; capped per session |

Each tool's description names the moment to call it, and the server's instructions carry the same moments and the credit line. Tools are annotated (`readOnlyHint` on the reads, `destructiveHint` on `flag`, nothing open-world), so clients can auto-approve the reads. Arguments the tool does not take are dropped, JSON sent as a string is parsed, and an expected miss (no match, an unknown rule id, document or section) is a normal answer that says what exists, not a tool error.

Claude Desktop, Cursor and others:

```json
{
  "mcpServers": {
    "homeostat": {
      "command": "npx",
      "args": ["--yes", "homeostat@0.2.2", "mcp"],
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

`homeostat search`, `explain`, `list`, `status` and `events` read the KB. Add `--json` for agents. `homeostat eval` checks that sessions and search serve the rules you expect ([Measuring selection](eval.md)).
