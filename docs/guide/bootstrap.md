# A first base: `homeostat bootstrap`

A new knowledge base starts empty, and the first rules wait for review comments to pile up. `homeostat bootstrap` gives each repo a base on day one, built from its local checkout. It sends code to the model, so it only runs when a person runs it: nothing schedules it.

## What it builds

For each repo in `repos` (or the one code repo of a KB without repo folders), into `knowledge/<repo>/core/docs/`:

| Part | Reads | Writes | Model |
| --- | --- | --- | --- |
| `docs` | `docs/**/*.md`, `CLAUDE.md`, `AGENTS.md`, ADRs, READMEs up to two folders deep | the same documents, converted as `docs convert` does (`source=imported`; a body `#` heading demoted, sections over 400 words split) | no |
| `code` | the file tree, READMEs, manifests and build files | `architecture`, `conventions`, `cross-repo` | yes |
| `data` | schema dumps, ORM files (recognised by a table definition in their text), migration setup, and the newest migrations of every history (Alembic, Flyway, Rails, plain SQL) | `data`: one section per database, its tables, relations, who writes what, and how migrations run | yes |
| `infrastructure` | Helm charts and values, Terraform (`*.tf`), Kubernetes manifests, Dockerfiles, compose files, CI pipelines | `infrastructure`: the services and jobs, where they run, how they talk, how each deploys | yes |

A document the repo already has wins over a model draft of the same name, and a document already in the KB is skipped unless you pass `--force`. A data or infrastructure part with nothing to read is skipped.

## Never read

Whatever the part:

- Terraform state (`*.tfstate*`, `.terraform/`) and variables (`*.tfvars`)
- `.env` and `.env.*`
- keys and certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, SSH keys)
- any file or folder named like `secret`
- Kubernetes `Secret` and `SealedSecret` manifests, found by their `kind`
- any file with three or more secret findings: it is left out rather than redacted and sent
- tests, vendored folders and build output
- anything in `sources.exclude.paths`

Everything else is cut to size and redacted for secrets before it is sent. Bootstrap reads checkouts only: no database connection, no cloud or cluster API.

## Running it

From the KB checkout, with the code repos checked out next to it (or in the current folder):

```sh
homeostat bootstrap --dry-run              # every file each part reads, and the token and cost estimate
homeostat bootstrap --dry-run --prompts    # the full prompts as well
homeostat bootstrap                        # the same summary, then asks before the first model call
```

The checkout is found by its `origin` remote matching `repos.<name>.source`, then by folder name. Point at one by hand with `--checkout api=../integrations-api`.

| Option | Meaning |
| --- | --- |
| `--repo <name>` | Only this repo; repeatable |
| `--checkout <repo>=<path>` | Where a repo is checked out; repeatable |
| `--parts <list>` | Some of `docs,code,data,infrastructure` (default all) |
| `--owner <member>` | Who owns the documents (default the first of `team.reviewers`, else the first lead) |
| `--yes` | Send without asking (for a run without a terminal) |
| `--force` | Replace documents already in the KB |

The model calls use `agents.curator` (its runtime and model). The cost estimate counts what is sent plus about 2,500 output tokens per document, at API prices; on a subscription runtime it is a size guide only.

## What you get

One pull request per repo on the KB repo. It lists the documents imported as they are, the drafted ones, and every file that was sent. Drafted sections are marked `source=bootstrap` with the model's confidence. Documents never merge on their own: read them, correct what is wrong, and merge. Other agents will treat them as fact. A document that links outside `security.allowedDomains` or talks about moving credentials is held until a member signs it off with `riskReviewedBy`, as for any document. Drafted sections are also checked for hostnames written without a link (`api.prod.acme.io`, `<slot>.dev.acme.io`), since a model copies them from manifests: add your own domains to `security.allowedDomains` if they may stay.

Rules from past reviews are not part of a bootstrap: the daily run's backfill (`SINCE`) drafts and scores those.
