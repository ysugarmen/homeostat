---
name: review
description: Walk the homeostat review queue with the user: the lessons the daily run could not decide on its own, in its open review PRs. Merge a PR to accept its lessons, close it to decline them. Use when the user wants to review pending team knowledge.
argument-hint: "[area or member]"
disable-model-invocation: true
allowed-tools: Read, Glob, Bash(homeostat review:*), Bash(npx --yes homeostat@0.2.2 review:*), Bash(homeostat explain:*), Bash(npx --yes homeostat@0.2.2 explain:*)
---

# Review the queue

Input: $ARGUMENTS (optional area or member to limit the queue)

Nobody approves lessons one by one. Each morning the daily run scores every lesson: confident ones merge on their own, weak ones are declined, and only the middle band goes to a human, in one review PR per developer. That PR is the queue. Merging it accepts its lessons; closing it declines them. The next daily run records the outcome, and each developer's session is told.

## 1. Find the knowledge base

Use the first that applies: the plugin setting `${user_config.kb_dir}` if it is not empty; the `HOMEOSTAT_DIR` environment variable; the current repository if it has a `homeostat.yaml`; otherwise ask the user for the path to their KB checkout. Pass it to every command below as `--dir <kb>`.

`homeostat review` works the same on GitHub and Bitbucket and only ever acts on homeostat's own PRs. It needs the KB's git-host token (`HOMEOSTAT_GITHUB_TOKEN` or `GITHUB_TOKEN`, or `HOMEOSTAT_BITBUCKET_TOKEN`); if it says one is missing, tell the user which variable to set rather than retrying.

## 2. Build the queue

```sh
homeostat review list --dir <kb> --json [--reviewer <the user's handle>]
```

It lists the open review PRs, plus any open daily PR the host refused to merge (for example, branch protection), whose lessons wait for a person too. It also lists dispute PRs (`kind: dispute`), one per flagged rule: merging puts the drafted fix in force, closing retires the rule. Say which it is before the user chooses. Each has its member, date, lesson count, reviewers and whether it conflicts with the base branch. With `--reviewer`, the PRs that ask the user come first; then the oldest. Filter by area or member if one was given. Say how many PRs and lessons there are before starting.

## 3. One PR at a time

`homeostat review show <n> --dir <kb>` shows the PR's table (each lesson with its decision, confidence and why it was not decided automatically), whether it merges cleanly, and the diff with the lessons themselves. For each lesson, show the title, rule, why, source (with link), author, confidence and the reason it waits, and point out anything that matters: a risky-content finding, a conflict with an existing rule, code it names that may not exist, a document section it changes. Then ask the user to choose for the whole PR:

- **Merge:** `homeostat review merge <n> --dir <kb>`. Every lesson in it is accepted. If it conflicts with the base branch and the KB groups rules into topic files, the command rebuilds the PR on the base branch (its rules are added beside the ones already there), waits for the host to catch up, and merges; that can take up to a minute. If it cannot rebuild (the same rule changed on both sides, or the KB has no topic files), it prints how to update the branch or close it; relay that, and do not try to resolve the conflict yourself. If the host refuses (for example, an approval is required), say why and point the user to the PR's link.
- **Close:** `homeostat review close <n> --dir <kb> --reason "<their reason>"`. Every lesson in it is declined, with that reason posted on the PR.
- **Keep some, drop others:** the user deletes what they reject from the PR branch (on the host's web page, or in a checkout): the lesson's file, or in a topic file its `##` section, comment included. Then merge. Only the lessons still in the PR are accepted.
- **Ask the author:** `homeostat review comment <n> --dir <kb> "<question>"`, and leave it open.
- **Skip:** leave it for later.

A lesson of kind `decision` with `adopted: false` is a record that the team considered a proposal and turned it down: its Rule is the proposal and its Why is why not. Merging it records the rejection, so agents stop proposing it; it never tells an agent to do the proposal. Describe it that way.

Never merge or close without the user's choice for that PR, and run only the command for the choice they made. Do not edit lesson files yourself.

## 4. Finish

Summarise what was merged, closed, commented on and skipped. The next daily run records the outcomes, and the authors' sessions are told; there is nothing else to do.
