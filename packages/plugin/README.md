# homeostat Claude Code plugin

Skills for working with a homeostat knowledge base from inside Claude Code:

| Command | What it does |
| --- | --- |
| `/homeostat:learn [lesson or PR comment URL]` | Drafts one entry from the session or a review comment, shows it to you, then writes it as a candidate with `homeostat learn`. |
| `/homeostat:explain <file or entry id>` | Lists the rules that apply to a file and why each exists, with source, owner and score. |
| `/homeostat:review [area]` | Walks candidate and disputed entries with you: accept, edit, retire or skip. |

The skills find the KB from the plugin's `kb_dir` setting, then `$HOMEOSTAT_DIR`, then the current repo if it has a `homeostat.yaml`, and otherwise ask. They run `homeostat` from the PATH, falling back to `npx --yes homeostat@0.1.0`. Nothing is committed or pushed unless you ask.

MCP: the plugin starts `homeostat mcp`, so every session also has the context, search, explain, learn, flag and report tools (see `packages/mcp`). Hooks: SessionStart injects the entries relevant to the files you are touching (step 2.3); Stop asks once per session for a handoff note after real edits (step 2.4). Point the plugin at your KB checkout with its `kb_dir` setting.

## Try it from a checkout

For one session:

```sh
claude --plugin-dir packages/plugin
```

Or install it through the repo's marketplace:

```sh
claude plugin marketplace add /path/to/homeostat
claude plugin install homeostat@homeostat
```

Check it with `claude plugin validate packages/plugin --strict` and `claude plugin validate . --strict`.
