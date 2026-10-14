# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository (a private security advisory). Do not open a public issue.

Include what you found, how to reproduce it, and the version (`homeostat --version`). We aim to acknowledge reports within 3 working days and to ship a fix or mitigation for confirmed high-severity issues within 30 days. We will credit you in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes while Homeostat is 0.x. Every release is published from GitHub Actions with npm provenance; see [docs/releasing.md](docs/releasing.md).

## Scope

Homeostat runs code in three places, and all of them are in scope:
- the hooks and MCP server on developers' machines
- the curator and deep dive in CI, which hold a git-host token and a model credential
- the local dashboard

Of special interest: anything that gets a rule into the knowledge base without a reviewer, past the auto-merge gates (a rule reaches every developer's agent), anything that makes a secret reach a prompt or a commit, and anything that widens what a token can touch.

How data is handled: [docs/data-handling.md](docs/data-handling.md). Threat model: [docs/security.md](docs/security.md). To check a setup: `homeostat doctor --security`.
