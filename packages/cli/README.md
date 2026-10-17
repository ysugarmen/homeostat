# homeostat

**Your team's code-review lessons, as rules every coding agent follows.**

Homeostat turns review feedback that led to a code change into short, scored rules and living team documents. It keeps them in a git repo where every change is a reviewed pull request, and gives every agent the ones that matter for the files it is touching: Claude Code (plugin and hooks), any MCP client, Cursor, Copilot and AGENTS.md.

```sh
# In a repo for your team's knowledge base:
npx --yes homeostat@0.1.7 init

# In Claude Code:
claude plugin marketplace add ysugarmen/homeostat
claude plugin install homeostat@homeostat
```

Common commands:
- `homeostat learn`: capture a rule
- `homeostat validate`: check the knowledge base
- `homeostat curate`: the daily curator, run in CI
- `homeostat export`: write rules files for other tools
- `homeostat mcp`: serve the MCP server
- `homeostat dashboard`: open the local dashboard
- `homeostat doctor --security`: check a setup

`homeostat --help` lists the rest.

- [Quickstart](https://github.com/ysugarmen/homeostat/blob/main/docs/guide/quickstart.md)
- [Guide](https://github.com/ysugarmen/homeostat/blob/main/docs/index.md)
- [Data handling](https://github.com/ysugarmen/homeostat/blob/main/docs/data-handling.md)

Every release is published from GitHub Actions with npm provenance. Apache-2.0.
