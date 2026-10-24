# homeostat Claude Code plugin

Skills for working with a homeostat knowledge base from inside Claude Code:

| Command | What it does |
| --- | --- |
| `/homeostat:learn [lesson or PR comment URL]` | Drafts one lesson from the session or a review comment, shows it to you, then saves it with `homeostat learn`. It applies to your sessions at once, and the next daily run decides it for the team. |
| `/homeostat:explain <file or entry id>` | Lists the rules that apply to a file and why each exists, with source, owner and score, using `homeostat explain`. Pending lessons and rejected decisions are labelled as such. |
| `/homeostat:review [area or member]` | Walks the daily run's open review PRs with you, lesson by lesson: merge to accept, close to decline, or ask the author. |

The skills find the KB from the plugin's `kb_dir` setting, then `$HOMEOSTAT_DIR`, then the current repo if it has a `homeostat.yaml`, and otherwise ask. They run `homeostat` from the PATH, falling back to `npx --yes homeostat@0.3.1`. Nothing is committed or pushed unless you ask.

MCP: the plugin starts `homeostat mcp`, so every session also has the context, search, explain, report, docs and read tools, plus learn and flag when the KB enables MCP writes (see `packages/mcp`). Hooks: SessionStart injects the rules relevant to the files you are touching (your repo's own plus the shared ones, best first), the document sections that name them, and a short guide that counts the rest by topic, names the moments to look things up and asks agents to credit what they used; UserPromptSubmit adds a one-line reminder of it on every message; Stop asks once per session for a handoff note after real edits, and logs per turn which Homeostat tools were called and which rules or sections the reply credited (tool names and ids only, kept in the local event log; `HOMEOSTAT_NO_TURN_USAGE=1` turns it off). SessionStart, UserPromptSubmit (at most every 3 hours) and Stop also run `homeostat sync` in the background, which pulls the team KB and sends your pending lessons. Point the plugin at your KB checkout with its `kb_dir` setting.

## Try it from a checkout

For one session:

```sh
claude --plugin-dir packages/plugin
```

Or install it from GitHub through the repo's marketplace:

```sh
claude plugin marketplace add ysugarmen/homeostat
claude plugin install homeostat@homeostat
```

Check it with `claude plugin validate packages/plugin --strict` and `claude plugin validate . --strict`.
