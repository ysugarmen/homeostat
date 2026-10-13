# End-to-end demo: from a review comment to a rule the agent follows

This is the step 2.8 check and the launch demo. One person runs it by hand on GitHub in under ten minutes: a reviewer's comment on a pull request turns into a team rule that the next Claude Code session follows.

## Before you start

- Node 24+, `git`, and the GitHub CLI logged in (`gh auth status`).
- `homeostat` on your PATH. Until it is on npm: `pnpm install && pnpm --filter homeostat link --global` in a checkout of this repo.
- Claude Code logged in (`claude`). The demo runs the agents through it (`agents.runtime: claude-code`), so your own subscription is enough. That is fine for a personal sandbox; a team KB uses a Console API key instead (the default), because a personal subscription is for personal, non-commercial use only.
- A **second GitHub account** for the reviewer. The curator only learns from feedback by someone other than the PR author.
- Claude Code with the homeostat plugin. From a checkout: `claude plugin marketplace add <path-to-homeostat>` then `claude plugin install homeostat@homeostat`.

Below, `ME` is your GitHub login and `REVIEWER` is the second account's login.

```sh
export ME=your-login REVIEWER=reviewer-login
```

## 1. Create the knowledge base (1 min)

```sh
gh repo create "$ME/homeostat-demo-kb" --private --clone && cd homeostat-demo-kb
homeostat init --member me --handle "@$ME"
```

Edit `homeostat.yaml`: add the reviewer as a senior member, a `frontend` area, and the sources.

```yaml
team:
  members:
    - id: me
      handle: "@your-login"
      role: senior
      areas: [core, frontend]
    - id: reviewer
      handle: "@reviewer-login"
      role: senior
      areas: [frontend]

areas:
  frontend: ["web/**"]

sources:
  host: github
  kbRepo: your-login/homeostat-demo-kb
  repos: [your-login/homeostat-demo-app]

# Personal sandbox: draft through your own Claude Code login.
agents:
  runtime: claude-code
```

```sh
homeostat validate && git add -A && git commit -m "homeostat init" && git push -u origin main
cd ..
```

## 2. Create the code repo (1 min)

```sh
gh repo create "$ME/homeostat-demo-app" --private --clone && cd homeostat-demo-app
mkdir -p web && printf '.button { color: #ffffff; background: #0055ff; }\n' > web/button.css
git add -A && git commit -m "button" && git push -u origin main
gh api -X PUT "repos/$ME/homeostat-demo-app/collaborators/$REVIEWER" -f permission=push
```

The reviewer accepts the invitation (email or github.com/notifications).

## 3. Open a PR and get review feedback (2 min)

```sh
git checkout -b link-style
printf '.link { color: #0055ff; }\n' > web/link.css
git add -A && git commit -m "link style" && git push -u origin link-style
gh pr create --fill
```

**As the reviewer**, on github.com: open the PR, go to *Files changed*, and comment on the `color` line in `web/link.css`:

> Use `var(--color-primary)` instead of a hex value: hex colours do not change with the theme, so they break dark mode.

## 4. Act on the feedback and merge (1 min)

```sh
printf '.link { color: var(--color-primary); }\n' > web/link.css
git commit -am "use colour token" && git push
gh pr merge --squash --delete-branch
```

The commit after the comment is what tells the curator the feedback was accepted (+3).

## 5. Run the curator and accept the rule (2 min)

In a team setup this runs in CI with a Console key. For the demo, run it from the KB checkout; it drafts through your Claude Code login:

```sh
cd ../homeostat-demo-kb
GITHUB_TOKEN=$(gh auth token) homeostat curate
```

Expect: `+ knowledge/frontend/....md (accepted, score 4)` and `opened https://github.com/.../pull/1`. Open that PR, read the entry, and merge it. Until homeostat is published on npm, the KB repo's own validate check fails with `E404`; run `homeostat validate` on the branch instead and merge with `--admin`:

```sh
gh pr merge --squash --delete-branch --admin && git pull
```

## 6. Start a session and see the rule applied (3 min)

Point the plugin at the KB checkout once, through `/plugin` settings (`kb_dir`), or for this shell:

```sh
export HOMEOSTAT_DIR="$PWD"
cd ../homeostat-demo-app && git pull
claude
```

Ask: *"Add a `.badge` style in web/badge.css with a blue background."*

Done when the agent uses `var(--color-*)` rather than a hex value without being told, and says so when asked why (`/homeostat:explain web/badge.css` shows the rule, its PR comment and its owner).

For Cursor and Copilot, run `homeostat export --kb ../homeostat-demo-kb --out .` in `homeostat-demo-app`, commit, and ask the same question in each tool.

## Clean up

```sh
gh repo delete "$ME/homeostat-demo-kb" --yes && gh repo delete "$ME/homeostat-demo-app" --yes
```
