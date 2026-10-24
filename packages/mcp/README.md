# @homeostat/mcp

The Homeostat knowledge base as an MCP server, so any agent can read and add to it.

| Tool | What it does |
| --- | --- |
| `context` | The team rules that apply to the given files, best first, within a token budget |
| `search` | Keyword search over accepted rules and document sections (runs locally, no model call), by area or path; 10 hits by default, each with a snippet and the id to open |
| `explain` | Why a rule exists: source comment, score breakdown, owner, conflicts, last confirmed |
| `learn` | Saves a lesson as a candidate rule on the caller's `candidates/<member>` branch |
| `flag` | Reports a rule as wrong: it loses score and goes back to review |
| `docs` | Lists the team's reference documents and their sections, for an area or a file |
| `read` | Reads one section (`doc` + `section`, or `area/topic#section`) or a whole document, each section once with where it came from |
| `report` | Knowledge base health over recent days |

Descriptions and the server instructions name the moments to look things up (a bug report, a test, new code or making parts fit, a why or what's-left question, a commit) and ask agents to credit what they used with `> From Homeostat (<id>)`; the plugin's Stop hook counts those credits per turn (see [docs/data-handling.md](../../docs/data-handling.md)). Tools carry MCP annotations: the reads are `readOnlyHint`, `flag` is `destructiveHint`, none is open-world. An expected miss (nothing matches, an unknown id, document or section) is a normal result that lists what exists, not an error.

`learn` and `flag` are off unless the KB sets `security.mcpWrites: true`, and then each session may make at most `security.mcpWriteLimit` (5) writes. An agent can be steered by text it reads, so by default it suggests and a person saves (`/homeostat:learn`, `homeostat learn`). Rules in `security.teamOnlyAreas` are only returned to members of that area. In a KB for several repos, every tool sees the session's own repo (found from the git remote of the folder the session runs in) plus the shared rules and documents.

Agents guess tool and argument names. Arguments a tool does not take (`explanation`, `reasoning`) are dropped, and arrays or objects sent as JSON strings are parsed (after vectorize-io/hindsight's tolerant arguments, MIT). Common guesses (`get_rules`, `remember`, `list`, `q`, `entry_id`, ...) are accepted and logged as desire paths in the KB's local event log (`.homeostat/events.db`); any other unknown tool is logged and answered with the real tool list and the closest match. `homeostat status` and the dashboard show them, so the common guesses can become real tools.

## Run it

The server is `homeostat mcp` (stdio). It finds the KB from `HOMEOSTAT_DIR`, or uses the current directory if it has a `homeostat.yaml`.

**Claude Code:** installing the Homeostat plugin starts it; set the plugin's `kb_dir`. Approve the read-only tools once, e.g. in `/permissions` allow `mcp__plugin_homeostat_homeostat__context`, `__search`, `__explain`, `__docs`, `__read`, `__report`.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "homeostat": {
      "command": "npx",
      "args": ["--yes", "homeostat@0.3.2", "mcp"],
      "env": { "HOMEOSTAT_DIR": "/path/to/your/kb-checkout" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in the code repo, or `~/.cursor/mcp.json`): the same `mcpServers` block.

**Codex / other clients:** any stdio MCP client; the command is `homeostat mcp`.
