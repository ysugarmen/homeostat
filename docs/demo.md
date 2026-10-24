# End-to-end demo: from a review comment to a rule the agent follows

One person runs it by hand on GitHub in under ten minutes: a reviewer's comment on a pull request turns into a team rule that the next Claude Code session follows.

## Before you start

- Node 22.18+, `git`, and the GitHub CLI logged in (`gh auth status`).
- `homeostat` on your PATH: `npm install -g homeostat@0.3.1`.
- Claude Code logged in (`claude`). The demo runs the agents through it (`agents.runtime: claude-code`), so your own subscription is enough. That is fine for a personal sandbox; a team KB uses a Console API key instead (the default), because a personal subscription is for personal, non-commercial use only.
- A **second GitHub account** for the reviewer. The daily run only learns from feedback by someone other than the PR author.
- Claude Code with the homeostat plugin: `claude plugin marketplace add ysugarmen/homeostat` then `claude plugin install homeostat@homeostat`.

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

The commit after the comment is what tells the daily run the feedback was accepted: a review comment followed by a code change starts at 50 points of confidence.

## 5. Run the daily run (2 min)

In a team setup this runs each morning in the KB repo's CI with a Console key. For the demo, run it from the KB checkout; it drafts through your Claude Code login:

```sh
cd ../homeostat-demo-kb
GITHUB_TOKEN=$(gh auth token) homeostat daily --dry-run
```

The dry run prints the decision and writes nothing. Expect `me: 1 merged, 0 to review, 0 declined`: the reviewer is a senior who owns `frontend`, so the lesson scores well past the 70 needed to merge on its own: 50 for the comment and the code change, 14 for a senior, 6 for the area's owner, plus points for naming real code and a clear title. The daily PR body shows the exact breakdown. Then run it for real:

```sh
GITHUB_TOKEN=$(gh auth token) homeostat daily
git pull
```

It opens `homeostat: daily lessons · me · <date>` with the decision and its score breakdown in the body, and merges it. If you made the reviewer a `member` instead, the lesson lands in a review PR: `homeostat review list`, then `homeostat review merge <number>`.

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

To see a first base built from the code itself, run `homeostat bootstrap --dry-run --checkout ../homeostat-demo-app` in the KB checkout ([details](guide/bootstrap.md)).

## Clean up

```sh
gh repo delete "$ME/homeostat-demo-kb" --yes && gh repo delete "$ME/homeostat-demo-app" --yes
```
