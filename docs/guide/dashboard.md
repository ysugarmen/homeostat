# Dashboard

```sh
homeostat dashboard --dir path/to/team-kb     # http://localhost:4747
```

A local, read-mostly view of the KB, the daily run's records (from the clone's copy of the `homeostat/state` branch, as of its last sync) and this machine's event log. It binds to localhost, loads nothing external, and sends nothing anywhere.

| Page | Shows |
| --- | --- |
| Overview | Health, agent liveness (last run, failures, next run), recent activity, and Setup: a bar of the required [setup](setup.md) steps done and the checklist, with the `homeostat setup --step` command for each missing step. Steps the files decide are read from them; the token, model credential, schedules and webhook show the last `homeostat setup` or `setup --check` result recorded on this machine, with its date. The card leads the page until every required step is done |
| Automation | The daily run: lessons merged, declined and sent to review per run; the review queue, with lessons waiting over 2 days marked; each developer's sync (last report, clone behind, pending lessons, version) |
| Performance | Whether it works and what it costs, over the last 30 days and 30 runs: the share merged without a person; calibration (decisions per confidence band against the configured lines, and how often reviewers merged what the run held back); lessons and KB health per run; reach (sessions given rules, the share of reachable rules served, starts that left rules out, covering documents opened, plus team counts from members who share them); use (the share of turns that looked something up and that credited it, credits after a lookup, distinct rules and sections credited, and rules served but never credited); runtime (session-start time and context size, MCP calls, each daily run's duration and model calls, syncs); and review latency with what still waits |
| Entries | Every rule by status, with the full explanation per rule |
| Members | Who contributes and reviews |
| Coverage | Areas and repos with and without rules |
| Impact | Sessions given rules, rules per session, the most-used rules, MCP tool use |
| Documents | Section reads and session use; sections unused and unconfirmed for 90 days are marked for review |
| Desire paths | Tool names agents guessed, which may be worth making real |
| Events | The raw event log |
| Settings | Forms for every key in `homeostat.yaml`; changes are written to the file, to commit on a branch |

`homeostat up` serves it too, alongside the scheduled agents. In Docker it listens on all interfaces: put it behind your own authentication.

## From the terminal

`homeostat metrics` prints the Performance page's figures as text, under the same headings, over the last 30 days and 30 daily runs (`--days`, `--runs`). `--json` prints one object for scripts and CI logs. It reads the clone and its local event log only, never the git host, so it is safe to run against any checkout.

## Share it with your team

`homeostat dashboard --build <dir>` writes the dashboard as static, read-only pages instead of serving it. CI rebuilds it on every push to the KB and publishes it, so the shared copy is never more than one CI run behind the repo, and no server runs anywhere. The recipe below uses Cloudflare Pages behind Cloudflare Access, both free (Access up to 50 users), so only your team can open it.

What the shared copy leaves out: event data never leaves a laptop, so Impact, Desire paths and Events are not built, agent activity on the Overview is empty (the daily run's own records, on the Automation page, are there), the Setup card keeps only the steps the repo's files decide (secrets, schedules and the webhook are checked on a laptop), and the Performance page keeps only what the state branch holds: decisions, calibration, review latency, the daily run's timing, and the usage counts of members who share them. Settings are read-only; change them through a PR to `homeostat.yaml`. Search and the theme switch need a server, so they are off.

**Once, in Cloudflare:**
1. Create a Pages project: `npx --yes wrangler@4.151.1 pages project create team-kb-dashboard --production-branch main` (or Workers & Pages > Create > Pages > Direct Upload).
2. Create an API token with the *Cloudflare Pages: Edit* permission, and note your account id.
3. In Zero Trust > Access > Applications, add a self-hosted application for `team-kb-dashboard.pages.dev` and `*.team-kb-dashboard.pages.dev` (the preview URLs), with an Allow policy for your team, e.g. emails ending in your company's domain, signing in with a one-time PIN or your identity provider. Open the URL in a private window to check it asks you to sign in.

**In the KB repo**, store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as secured variables (Bitbucket) or secrets (GitHub), and `CLOUDFLARE_PAGES_PROJECT` as a plain variable.

**Bitbucket Pipelines** (`bitbucket-pipelines.yml`): add the step to the `main` pipeline and give `homeostat/state`, which the daily run pushes, its own. Bitbucket runs only the most specific matching pipeline per push.

```yaml
definitions:
  steps:
    - step: &homeostat-dashboard
        name: homeostat dashboard
        script:
          # A push to homeostat/state checks out the state branch; the dashboard is built from main.
          - git fetch --quiet origin "+refs/heads/*:refs/remotes/origin/*"
          - git checkout --quiet --detach origin/main
          - npx --yes homeostat@0.5.0 dashboard --build site
          - npx --yes wrangler@4.151.1 pages deploy site --project-name "$CLOUDFLARE_PAGES_PROJECT" --branch main

pipelines:
  branches:
    main:
      - step: *homeostat-validate
      - step: *homeostat-dashboard
    homeostat/state:
      - step: *homeostat-dashboard
```

**GitHub Actions** (`.github/workflows/homeostat-dashboard.yml`):

```yaml
name: homeostat dashboard
on:
  push:
    branches: [main, homeostat/state]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: homeostat-dashboard
  cancel-in-progress: true
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: main
          fetch-depth: 0
      - run: git fetch --quiet origin "+refs/heads/*:refs/remotes/origin/*"
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - run: npx --yes homeostat@0.5.0 dashboard --build site
      - run: npx --yes wrangler@4.151.1 pages deploy site --project-name "${{ vars.CLOUDFLARE_PAGES_PROJECT }}" --branch main
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Each build takes about a minute of CI time. Bitbucket's Free plan has 50 minutes a month, which a busy KB outgrows; Standard has 2,500. Developers' syncs push to `candidates/*` and only change the sync column on the Automation page; add `candidates/**` to the triggers if you want that live too, at the cost of a build per sync.
