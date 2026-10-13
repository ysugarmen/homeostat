# @homeostat/mcp

The Homeostat knowledge base as an MCP server, so any agent can read and add to it.

| Tool | What it does |
| --- | --- |
| `context` | The team rules that apply to the given files, best first, within a token budget |
| `search` | Keyword search over accepted rules (runs locally, no model call), by area or path |
| `explain` | Why a rule exists: source comment, score breakdown, owner, conflicts, last confirmed |
| `learn` | Saves a lesson as a candidate rule on the caller's `candidates/<member>` branch |
| `flag` | Reports a rule as wrong: it loses score and goes back to review |
| `report` | Knowledge base health over recent days |

Agents guess tool and argument names. Common guesses (`get_rules`, `remember`, `list`, `q`, `entry_id`, ...) are accepted and logged as desire paths in the KB's `.homeostat/events.jsonl`; any other unknown tool is logged and answered with the real tool list and the closest match. `homeostat report` shows the count, so the common guesses can become real tools.

## Run it

The server is `homeostat mcp` (stdio). It finds the KB from `HOMEOSTAT_DIR`, or uses the current directory if it has a `homeostat.yaml`.

**Claude Code:** installing the Homeostat plugin starts it; set the plugin's `kb_dir`. Approve the read-only tools once, e.g. in `/permissions` allow `mcp__plugin_homeostat_homeostat__context`, `__search`, `__explain`, `__report`.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "homeostat": {
      "command": "npx",
      "args": ["--yes", "homeostat@0", "mcp"],
      "env": { "HOMEOSTAT_DIR": "/path/to/your/kb-checkout" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` in the code repo, or `~/.cursor/mcp.json`): the same `mcpServers` block.

**Codex / other clients:** any stdio MCP client; the command is `homeostat mcp`.
