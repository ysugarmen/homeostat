# kbx

Turn accepted code-review feedback into scored, governed team knowledge that every coding agent can use.

> Early development. The design and the live plan are in [`docs/design.md`](docs/design.md) and [`docs/execution-plan.md`](docs/execution-plan.md).

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Entry schema, scoring, conflict detection, validation, git-host providers |
| `packages/cli` | `kbx` command line |
| `packages/mcp` | MCP server (not started) |
| `packages/plugin` | Claude Code plugin (not started) |
| `packages/dashboard` | Dashboard (not started) |
| `examples/starter-kb` | A small example knowledge base |

## Development

```sh
pnpm install
pnpm check   # lint + typecheck + tests
```

## Licence

[Apache-2.0](LICENSE).
