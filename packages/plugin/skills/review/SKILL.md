---
name: review
description: Walk the homeostat review queue with the user: the lessons the daily run could not decide on its own, in its open review PRs. Merge a PR to accept its lessons, close it to decline them. Use when the user wants to review pending team knowledge.
argument-hint: "[area or member]"
disable-model-invocation: true
allowed-tools: Read, Glob, Bash(gh pr list:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr merge:*), Bash(gh pr close:*), Bash(gh pr comment:*), Bash(homeostat explain:*), Bash(npx --yes homeostat@0.1.5 explain:*)
---

# Review the queue

Input: $ARGUMENTS (optional area or member to limit the queue)

Nobody approves lessons one by one. Each morning the daily run scores every lesson: confident ones merge on their own, weak ones are declined, and only the middle band goes to a human, in one review PR per developer. That PR is the queue. Merging it accepts its lessons; closing it declines them. The next daily run records the outcome, and each developer's session is told.

## 1. Find the knowledge base and its repo

Use the first that applies: the plugin setting `${user_config.kb_dir}` if it is not empty; the `HOMEOSTAT_DIR` environment variable; the current repository if it has a `homeostat.yaml`; otherwise ask the user for the path to their KB checkout. Read `sources` in its `homeostat.yaml` for the host and `kbRepo`.

On Bitbucket there is no `gh`: list the open PRs whose branch starts with `homeostat/review-` for the user to open in the browser, and walk them through the same choices there.

## 2. Build the queue

```sh
gh pr list --repo <kbRepo> --state open --search "head:homeostat/review-" --json number,title,headRefName,createdAt,reviewRequests,url
```

Also include any open `homeostat/daily-` PR: it is one the host refused to merge (for example, branch protection), so its lessons wait for a person too. Put PRs that request the user's review first, then the oldest. Filter by area or member if one was given (the member is in the branch name). Say how many PRs and lessons there are before starting.

## 3. One PR at a time

`gh pr view <n> --repo <kbRepo>` shows a table: each lesson with its decision, confidence and why it was not decided automatically. `gh pr diff <n> --repo <kbRepo>` shows the lessons themselves. For each lesson, show the title, rule, why, source (with link), author, confidence and the reason it waits, and point out anything that matters: a risky-content finding, a conflict with an existing rule, code it names that may not exist, a document section it changes. Then ask the user to choose for the whole PR:

- **Merge:** `gh pr merge <n> --repo <kbRepo> --squash`. Every lesson in it is accepted.
- **Close:** `gh pr close <n> --repo <kbRepo> --comment "<their reason>"`. Every lesson in it is declined, with that reason.
- **Keep some, drop others:** the user deletes the files they reject from the PR branch (on the PR's Files tab, or in a checkout), then merges. Only the lessons still in the PR are accepted.
- **Ask the author:** `gh pr comment <n> --repo <kbRepo> --body "<question>"`, and leave it open.
- **Skip:** leave it for later.

Never merge or close without the user's choice for that PR. Do not edit lesson files yourself.

## 4. Finish

Summarise what was merged, closed, commented on and skipped. The next daily run records the outcomes, and the authors' sessions are told; there is nothing else to do.
