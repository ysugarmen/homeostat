# 0.2.0: one knowledge base for several repos, rules grouped by topic, and a first base for each

Status: proposal, for review before any code.

## The problem

A team often owns more than one repo. Today a KB has one set of `areas`, path globs with no repo attached, and every rule lives at `knowledge/<area>/<id>.md`. With two repos:

- `services/**` in `api` and `services/**` in `worker` are the same glob, so a rule learned in one repo is injected into sessions in the other.
- Both repos' lessons share one folder per area, so nobody can see or own "the rules for `api`".
- The daily run compares lessons across repos as if they were one codebase, so two different rules about two different `config.py` files can be merged as duplicates.

## What changes for a team

```yaml
# homeostat.yaml
repos:
  api:                                  # short name: the folder under knowledge/
    source: acme/api                    # the git-host repo the daily run reads
    areas:
      payments: ["services/payments/**"]
      search: ["services/search/**"]
  worker:
    source: acme/worker
    areas:
      jobs: ["jobs/**"]

sources:
  host: github
  kbRepo: acme/team-kb                  # sources.repos goes away: it is repos.*.source
```

```text
knowledge/
  core/                     shared: holds in every repo the team owns
    docs/
  api/
    core/                   anywhere in api
    payments/
      use-the-ledger-client.md
      docs/ledger.md
    search/
  worker/
    core/
    jobs/
```

- A session in a checkout of `api` gets `knowledge/core/` plus `knowledge/api/`, matched by path as today. It never gets `worker`'s rules.
- Scopes stay globs relative to the repo root, so existing rules keep their scope unchanged.
- Area names belong to a repo: `api` and `worker` may each have a `jobs` area. Elsewhere, an area is named `<repo>/<area>`, as in `teams.*.areas: [api/payments]`.

**Compatibility.** A KB without `repos:` keeps working as now: one implicit repo, `knowledge/<area>/`, every rule applying to every listed repo. Nothing is forced. `homeostat migrate` converts a KB when its team is ready, and `validate` tells a team with more than one source repo that migrating would separate their rules.

## Which repo a session is in

The hooks, the MCP server, `learn` and `export` need the current repo. In order:

1. `git remote get-url origin` in the session's folder, matched against `repos.*.source` (host-neutral: owner/name, any case, SSH or HTTPS).
2. The checkout folder's name, matched against the short names, for clones without a remote.
3. Neither matches: shared `core` only. The session start says so once, and `doctor` lists checkouts it could not place.

Checked: Claude Code starts the plugin's MCP server in the session's project folder, and sets `CLAUDE_PROJECT_DIR`. So the MCP server reads the remote from its own working folder, as the hooks read it from their `cwd`, and the MCP tools need no `repo` argument.

## Command by command

| Command | Change |
|---|---|
| `validate` | Entry paths are `knowledge/core/<id>.md` (shared) or `knowledge/<repo>/<area>/<id>.md`, the same for `docs/`. The repo folder must be a key of `repos`, and the area `core` or one of that repo's areas. The repo is read from the path, not stored in the frontmatter, so files carry no new field. |
| `learn <url>` | The repo comes from the PR URL, matched on `source`. |
| `learn` (by hand) | The repo comes from the current checkout; `--repo` overrides; outside any checkout, `--repo` is required, or `--shared` for `knowledge/core/`. |
| `curate`, `daily` | A lesson from a PR in `api` goes to `knowledge/api/<area>/`, and the drafter is shown only `api`'s areas. Duplicates and reconfirmations are checked within the same repo, plus against shared `core`. |
| `deep-dive` | Duplicates and contradictions are checked per repo plus shared `core`. New note: the same rule in two repos is a candidate for shared `core`, so a person decides whether to promote it. |
| `docs convert`, `seed` | `--repo` (default: the current checkout) places documents under `knowledge/<repo>/<area>/docs/`. |
| `export --out <checkout>` | Exports shared `core` plus that checkout's repo only. |
| `codeowners` | Lines per `/knowledge/<repo>/<area>/`; `team.reviewers` keeps overriding, as in 0.1.11. |
| `search`, `context`, `explain` (MCP) | Scoped to the session's repo plus shared `core`; `search` gets an optional `repo` to look across repos. |
| Dashboard | A repo filter on Entries, Coverage and Impact; the Overview counts rules per repo. |
| `digest` | New rules grouped by repo. |
| Events | Injection events record the repo, so Impact can show usage per repo. |

## Migration: `homeostat migrate`

```sh
homeostat migrate --repo api          # one source repo: everything moves under knowledge/api/
homeostat migrate --map payments=api --map jobs=worker --shared core   # several
```

- **With one source repo:** `knowledge/<area>/…` moves to `knowledge/<repo>/<area>/…`, including `core`, since those rules were learned from that repo. Shared `knowledge/core/` starts empty, and the deep dive later proposes promotions.
- **With several,** each area is mapped to a repo, and `--shared core` keeps today's `core` rules shared.
- **Config:** `areas:` and `sources.repos` are rewritten into `repos:`, and `teams.*.areas` get repo-qualified names.
- **Writes:** it changes the working tree and stops there. A person reviews the result and commits it on a branch with a PR, like any KB change.
- **Refusals:** it refuses while review PRs are open, because their file paths would no longer match `main`. Decide or close them first.
- **State branch:** decision records keep their ids, but their paths are rewritten, so the daily run still settles and dedupes correctly.
- **Developers' pending lessons:** the next `sync` moves `.homeostat/pending/knowledge/<area>/…` to the matching repo folder, using the same mapping, which `migrate` records in `homeostat.yaml` under `migrated:`.

## Rules grouped by topic

Today every rule is its own file, so a KB of 70 rules is 70 files, and one review PR of 64 lessons is 64 files to click through. In 0.2.0, rules are grouped into one file per topic, inside their area:

```text
knowledge/api/core/migrations.md      # every migrations rule of repo api
knowledge/api/core/testing.md
knowledge/api/payments/ledger.md
```

```markdown
## Keep million-row backfills out of schema migrations {#keep-million-row-backfills}
<!-- homeostat: status=accepted owner=sam score=4 source=pr-feedback url=https://github.com/acme/api/pull/4504#discussion_r33 created=2026-10-19 confirmed=2026-10-19 scope=migrations/** -->
A rule, at most 60 words, naming the function, path or package.

**Why:** the reason, from the review.
```

- **One section per rule.** It carries what the frontmatter carries today: id, status, owner, score, source, dates, scope and flags, in one comment line. The file's own frontmatter holds only the topic's title and description. The section format follows documents, so parsing and validation share code.
- **The topics are a fixed list.** Each repo lists its topics in the config, a name and a one-line description each:
  ```yaml
  repos:
    api:
      source: acme/api
      topics:
        migrations: "Alembic schema changes, backfills and their deploy order"
        testing: "What tests assert, fixtures, mocks"
  ```
  `migrate` and `bootstrap` propose a first list from the existing rules and code; a person approves it in that PR.
- **Classifying a lesson needs no extra model call.** The drafter already picks each lesson's area, so it now picks the topic from the same list in the same call. If none fits, it proposes a new topic, and that lesson goes to review, so new topics never appear on their own. A hand-written `learn` takes `--topic`. Without it, the topic is picked by matching words against the topic names and descriptions, with no model. If nothing matches, the rule goes to `general`.
- **Conflicts.** Sections stay sorted by id, so two PRs adding rules to one topic usually touch separate lines. When git still reports a conflict, the daily run and `homeostat review merge` rebuild the topic file from both sides, since every section is self-contained, so nobody resolves a rule-file conflict by hand.
- **What carries over:**
  - Ids, scopes, scores, flags, disputes and decisions all stay per rule; only the storage changes.
  - The state branch still records decisions per rule id.
  - `explain`, `search`, injection and the dashboard read sections exactly as they read files today.
- **Migration:** `migrate` folds today's files into topic files. One-repo KBs get this too, with the topics proposed from their rules, and old one-file rules keep validating until migrated.

## A first base for each repo: `homeostat bootstrap`

A new KB starts empty, and the first useful rules wait for review comments to accumulate. `bootstrap` gives each repo a base on day one. `init` ends by offering it ("Build a first base from your repos now?"), and it can also be run later. It sends code to the model, so like `seed` it only ever runs by hand, never on a schedule.

For each repo in `repos`, from a local checkout (found by remote, or given with `--checkout <repo>=<path>`):

| Part | From | Into | Model |
|---|---|---|---|
| Existing docs | `docs/`, `CLAUDE.md`, `AGENTS.md`, ADRs, READMEs | `knowledge/<repo>/core/docs/`, converted with `docs convert`, which also cleans repeated and empty headings | no |
| Code docs | the file tree, manifests, build files: today's `seed` | architecture, conventions, cross-repo | yes |
| Data | migrations (Alembic, Flyway, plain SQL DDL), ORM models, schema dumps | one document per database: tables and key columns, relations, which service writes what, how the repo runs, tests and deploys migrations | yes |
| Infrastructure | Helm charts, Terraform, Kubernetes manifests, Dockerfiles, CI pipelines, on any cloud | services and where they run (GKE, EKS, ...), how they talk, how each is deployed, scheduled jobs | yes |

- **Preview first:** `bootstrap --dry-run` lists every file it would read per repo and part, with a token and cost estimate, and prints the prompts. A real run shows the same summary and asks before the first model call.
- **Never read:**
  - Terraform state (`*.tfstate*`)
  - `.env*` files
  - Kubernetes `Secret` manifests and sealed secrets
  - key and certificate files (`*.pem`, `*.key`)
  - anything in `sources.exclude.paths`

  Everything that is read is redacted for secrets before it is sent.
- **Same checks as any document:** an internal hostname or credential talk holds the document until a member signs it off (`riskReviewedBy`), as for imported documents today.
- **Writes:** one PR per repo on the KB repo, with every section marked `source=bootstrap` and the model's confidence. Documents always go to the reviewers, never merged on their own. Existing documents are skipped unless `--force`.
- **Not included:** rules from past reviews. They stay with the daily run's backfill (`SINCE`), which scores each one.
- **Implementation:** the data and infrastructure parts are new `seed` topics (`data`, `infrastructure`), each with its own file picker. Their prompts stay small: a schema is summarised from migrations and models, not from rows; infrastructure from manifests, not live clusters. `bootstrap` orchestrates the four parts per repo and reuses `seed`'s and `docs convert`'s code.

## Out of scope for 0.2.0

- **Repos on different hosts** (a GitHub KB reading Bitbucket code). It stays one `sources.host`.
- **Per-repo thresholds or reviewers.** `scoring` and `team.reviewers` stay team-wide.
- **Reading live systems.** `bootstrap` reads checkouts only: no database connections, no cloud or cluster APIs.

## Order of work

1. **Model:** config `repos:`, path rules, a `repoOf(path)` helper, and legacy-layout detection. Covered by `validate` tests in both layouts. *Done.*
2. **Topic storage:**
   - the section format, parsed and validated
   - the topic list in the config
   - one read/write layer that every command uses, so that later steps write sections, not files
   - sorted writes, and rebuilding a topic file when a PR conflicts
3. **Repo detection:** for the hooks, the CLI and the MCP server (which runs in the session's folder), from git remotes, with the folder name as fallback.
4. **Selection:** injection, MCP `context` and `search`, and `export`, scoped to repo plus shared core.
5. **Writing:**
   - `learn` (`--topic` and the word-match fallback), `curate` and `daily`, with the drafter choosing the topic
   - flags and disputes
   - `docs convert` and `seed`, placed by repo
   - duplicates compared per repo
6. **Deep dive, CODEOWNERS, digest and dashboard.**
7. **`migrate`:**
   - moving rules to repo folders and folding them into topic files, with a proposed topic list
   - rewriting paths on the state branch
   - moving pending lessons in `sync`
8. **`bootstrap`:**
   - the existing-docs part first, since it needs no model
   - the `data` and `infrastructure` seed topics, with their file pickers and exclusions
   - the dry-run preview with its cost estimate
   - `init`'s offer at the end

   *Done.* The dry run lists each file and prints prompts with `--prompts`. Beyond the plan, test folders, `secrets/` folders and files with three or more secret findings are never read, ORM files are recognised by their text, and migration histories share the budget.
9. **Docs:** quickstart, config, entries, architecture, a migration guide, and a bootstrap guide.
10. **Release 0.2.0.** The acceptance test has two parts:
   - Migrate one real single-repo KB. New rules land under `knowledge/<repo>/`, sessions get the same rules as before, and the review PRs settle.
   - Run `bootstrap` on a real repo with migrations and Helm charts. Its PR holds the four parts, and the preview lists exactly what was sent.

Rough size: larger than the automation redesign. Multi-repo is about that size, and `bootstrap` adds two new seed topics and the orchestration. Each step lands with tests and leaves the KB working in both layouts.
