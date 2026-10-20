# Moving to 0.2: repo folders and topic files

0.2 adds two layouts. Both are optional: a 0.1 knowledge base keeps working as it is.

- **Repo folders:** one KB for several code repos, `knowledge/<repo>/<area>/`, with shared rules in `knowledge/core/`. A session gets the shared rules plus its own repo's, never another repo's.
- **Topic files:** rules grouped into one file per topic, `knowledge/<repo>/<area>/<topic>.md`, one `##` section per rule, instead of one file per rule.

`homeostat migrate` moves a 0.1 KB into repo folders and, with `--topics`, into topic files as well.

## Before you start

1. Upgrade the CLI pin in your CI files and the plugin to 0.2 (`claude plugin update homeostat@homeostat`).
2. Decide or close the open `homeostat/` PRs: `migrate` moves every file, so an open PR would conflict. It asks the host and stops if one is open (`--skip-pr-check` when you have no token at hand and know there is none).
3. Work on a branch of the KB checkout.

## One code repo

```sh
homeostat migrate --dry-run                # the plan: every move, and the new config
homeostat migrate --topics --dry-run       # also group the rules into topics the model proposes
homeostat migrate --topics
```

- The repo's short name defaults to its own name on the host; set it with `--repo api`.
- `--shared` keeps the `core` rules in `knowledge/core/` for repos you add later; without it, they move to `knowledge/<repo>/core/`.
- `--topics` asks the model once per repo (and once for the shared rules) for a topic list, a name and a one-line description each, covering every rule. It writes the list into `repos.<name>.topics` and folds the rules into topic files. Rename or merge topics in the PR: the list is the team's to approve.

## Several code repos

When one KB already serves several repos, say which repo each area belongs to:

```sh
homeostat migrate --map integrations=api --map frontend=web --shared --dry-run
```

## After it runs

`migrate` rewrites `homeostat.yaml` (keeping its comments): `areas` and `sources.repos` become `repos.<name>.{source, areas, topics}`, and `migrated.on` and `migrated.areas` record what moved where. Then:

```sh
homeostat codeowners        # owners per repo folder
homeostat validate
git diff --stat             # review, commit on a branch, open a PR
```

Once it merges:

- the daily run files each new lesson under the repo its PR came from, and the drafter picks its topic from the list (a new topic sends the lesson to a reviewer)
- `learn` takes the repo from the comment URL or the checkout's remote, and `--topic` (else a word match, else `general`)
- developers' pending lessons move to the new paths on their next sync
- the dashboard filters by repo, and `export` writes each repo's own rules

To add a repo later, add it under `repos` with its `source` and `areas`, and run [`homeostat bootstrap --repo <name>`](bootstrap.md) for a first base.
