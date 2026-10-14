# Homeostat

Your team already teaches its coding agents, one review comment at a time, and they forget it all by the next session. Homeostat keeps that knowledge.

It turns accepted code-review feedback into short, scored rules and team documents. They live as Markdown in a git repo, change only by pull request, and reach every agent: Claude Code (plugin and hooks), any MCP client, and Cursor, Copilot and AGENTS.md through exported rules files.

## How it works

1. **Capture.** A daily curator in your CI reads merged pull requests. Where a reviewer's comment led to a code change, it drafts a rule and opens a PR on the knowledge-base repo. People and agents add rules and document sections too.
2. **Govern.** Every entry is scored and reviewed by the team that owns its area. Only entries that pass every safety gate merge on their own. A weekly deep dive merges duplicates, flags contradictions and retires stale rules.
3. **Deliver.** Each session gets the rules and document sections for the files it touches, within a token budget.

## Guide

- [Quickstart](guide/quickstart.md): a working knowledge base in ten minutes
- [Rules and documents](guide/entries.md): the file formats
- [Configuration](guide/config.md): every key in `homeostat.yaml`
- [The agents](guide/agents.md): curator, deep dive, auto-merge, seeding, the digest, and model runtimes
- [Using it from your tools](guide/clients.md): the Claude Code plugin, MCP, and exports
- [Dashboard](guide/dashboard.md)

## Trust

- [Data handling](data-handling.md): what is read, what leaves your network, how to turn each part off
- [Security model](security.md) and [reporting a vulnerability](https://github.com/ysugarmen/homeostat/blob/main/SECURITY.md)
- [Runtimes](runtimes.md): keep model calls inside your own AWS or Google Cloud account
- [Releasing](releasing.md): pinned versions and npm provenance

## Project

[Design](design.md) · [Contributing](https://github.com/ysugarmen/homeostat/blob/main/CONTRIBUTING.md) · [GitHub](https://github.com/ysugarmen/homeostat) · Apache-2.0
