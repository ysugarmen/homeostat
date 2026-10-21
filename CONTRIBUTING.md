# Contributing to Homeostat

Thanks for helping. Homeostat turns a team's accepted review feedback into rules every coding agent follows, so the bar is: small, tested, and safe to run on every developer's machine.

## Set up

You need Node 24 (`.nvmrc`; Node 22.18+ works) and pnpm 10.

```sh
git clone https://github.com/ysugarmen/homeostat && cd homeostat
pnpm install
pnpm check        # lint, typecheck, tests: what CI runs
```

Run the CLI from source with `node packages/cli/bin/homeostat.js <command>`; `examples/starter-kb` is a small knowledge base to try it on. `homeostat dashboard --dir examples/starter-kb` serves the dashboard.

## Layout

| Package | What it is |
| --- | --- |
| `packages/core` | Schema, validation, scoring, selection, topic files and repo layout, the agents (daily-run drafting, deep dive, bootstrap), git-host providers. Pure where possible. |
| `packages/cli` | The `homeostat` command. Thin: it reads files, calls core, prints. |
| `packages/mcp` | The MCP server. |
| `packages/dashboard` | The local dashboard: server-rendered HTML, no framework. |
| `packages/plugin` | The Claude Code plugin: skills, hooks, `.mcp.json`. |

Design and plan: [docs/design.md](docs/design.md), [docs/execution-plan.md](docs/execution-plan.md). Threat model: [docs/security.md](docs/security.md).

## How we work

- **Tests first, and with every change.** Behaviour lives in a test. CLI tests run the real commands against temporary copies of `examples/starter-kb`; nothing touches your real config or the network.
- **Small pull requests, conventional commits** (`feat(scope): …`, `fix: …`, `docs: …`), one concern each.
- **TypeScript that Node can run directly.** The bin runs the sources with Node's type stripping, so `erasableSyntaxOnly` is on: no enums, no parameter properties, no namespaces.
- **New dependencies need a discussion first.** Homeostat runs in every session on every developer's machine; each package is supply-chain surface. Open an issue before adding one.
- **No secrets, no real company data**, not even in fixtures. Build token-shaped test strings at runtime (see `packages/core/test/secrets.test.ts`).
- **Every config key is editable in the dashboard.** A test enforces it: when you add a key to `config.ts`, add its field in `packages/dashboard/src/settings.ts`.
- **MCP tool descriptions stay under 200 characters**, and guessed tool names go in the alias table rather than new tools.
- **Exact versions only.** Never pin homeostat to a range (a bare major, `^`, `~` or `latest`) anywhere; `scripts/version.mjs` sets the release version everywhere.
- **Security changes** (anything about what is read, sent, merged or exported) update [docs/data-handling.md](docs/data-handling.md) in the same PR.

## Pull requests

1. Open or comment on an issue first for anything bigger than a fix, so we agree on the shape.
2. Run `pnpm check` and `pnpm format`.
3. Describe what changed and how you tested it. Screenshots for dashboard changes.

Issues labelled [good first issue](https://github.com/ysugarmen/homeostat/labels/good%20first%20issue) are small, self-contained and have a pointer to where to start.

## Reporting security problems

Not in public issues: see [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part follows our [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
