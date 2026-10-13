---
name: review
description: Walk the homeostat knowledge base review queue with the user, accepting, editing or retiring candidate entries one at a time. Use when the user wants to review pending team knowledge.
argument-hint: "[area]"
disable-model-invocation: true
allowed-tools: Read, Glob, Edit, Bash(homeostat validate:*), Bash(npx --yes homeostat@0 validate:*)
---

# Review candidate entries

Input: $ARGUMENTS (optional area to limit the queue)

## 1. Find the knowledge base

Use the first that applies: the plugin setting `${user_config.kb_dir}` if it is not empty; the `HOMEOSTAT_DIR` environment variable; the current repository if it has a `homeostat.yaml`; otherwise ask the user for the path to their KB checkout. Read `homeostat.yaml` for the members and `scoring.autoMergeThreshold`.

Ask which member the user is, if it is not obvious; only that id goes into `approvedBy`.

## 2. Build the queue

Every entry under `knowledge/` with `status: candidate` or `status: disputed`, filtered to the area if one was given, highest `score` first. Say how many there are before starting.

## 3. One entry at a time

Show the title, rule, why, source (with link), author, owner and score, and any `conflictsWith`. Then ask the user to choose:

- **Accept:** set `status: accepted`. If the score is below the threshold, also set `approvedBy: <their member id>`.
- **Edit:** apply their wording changes to the Rule or Why, keep it a candidate, and show it again.
- **Retire:** set `status: retired`.
- **Skip:** leave it unchanged.

Only edit the frontmatter fields named above and the sections the user asked to change. Never change `score` or `tokens` by hand.

## 4. Finish

Run `homeostat validate "<kb>" --fix` (or `npx --yes homeostat@0 validate "<kb>" --fix`), which recomputes `score` and `tokens`. Report any errors and fix them with the user.

Summarise what was accepted, edited, retired and skipped, and remind the user the changes need committing on a branch and a PR to the KB repo. Do not commit or push unless asked.
