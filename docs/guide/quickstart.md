# Quickstart

You need Node 22.18 or later and a git repo for the knowledge base (KB). It can be a new, empty repo; your code stays where it is.

## 1. Create the knowledge base

```sh
git clone git@github.com:your-org/team-kb.git && cd team-kb
npx --yes homeostat@0.1.1 init --member your-id --handle @your-github-user
```

`init` writes `homeostat.yaml`, `knowledge/core/`, and CI jobs for your git host (GitHub Actions or Bitbucket Pipelines):
- validation on every PR
- the daily curator and the weekly deep dive
- the weekly digest

It also prints which tokens to create and how to protect the branch.

## 2. Describe your team

Edit `homeostat.yaml` (all keys: [configuration](config.md)):

```yaml
team:
  members:
    - { id: dana, handle: "@dana", role: senior, areas: [integrations] }
    - { id: lee, handle: "@lee", role: member, areas: [frontend] }
areas:
  integrations: ["services/integrations/**"]
  frontend: ["apps/web/**"]
sources:
  host: github
  kbRepo: your-org/team-kb
  repos: [your-org/api, your-org/web]
```

Then generate CODEOWNERS, so each area's owners review its changes:

```sh
npx --yes homeostat@0.1.1 codeowners
npx --yes homeostat@0.1.1 validate
```

## 3. Write a first rule

```sh
npx --yes homeostat@0.1.1 learn --area integrations \
  --title "Use the shared retry helper for partner calls" \
  --rule "Wrap every outbound partner call in withRetry() from @acme/http-client." \
  --why "Hand-rolled retries skipped the request-id header partners ask for."
```

Or capture it from a review comment: `homeostat learn <comment URL>`. Commit on a branch, open a PR, and once it is approved the rule is live.

## 4. Get it to your agents

- **Claude Code**: install the plugin and point it at your KB checkout ([details](clients.md)):

  ```sh
  claude plugin marketplace add ysugarmen/homeostat
  claude plugin install homeostat@homeostat
  ```

- **Cursor, Copilot, AGENTS.md**: from a code repo, run `homeostat export --kb ../team-kb`.
- **Any MCP client**: run `homeostat mcp`.

## 5. Turn on the daily run

Add the secrets `init` printed: a git-host token and a Claude credential, or use your cloud account ([runtimes](../runtimes.md)). Run `homeostat curate --show-prompts` once to see exactly what would be sent, and `homeostat daily --dry-run` to see what it would decide. From then on, each morning, every developer's lessons and what their reviewers taught them arrive in one PR per developer. Confident lessons merge themselves; only the uncertain ones wait for a reviewer ([how it decides](agents.md#daily)). Developers need nothing beyond the plugin: their sessions sync in the background.

Before you invite the team, run `homeostat doctor --security`.
