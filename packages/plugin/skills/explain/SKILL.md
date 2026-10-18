---
name: explain
description: Explain which homeostat knowledge base rules apply to a file and why each exists, with its source PR, score and owner. Use when the user asks why a team rule exists or what rules cover a file.
argument-hint: "<file path or entry id>"
allowed-tools: Bash(homeostat explain:*), Bash(homeostat search:*), Bash(npx --yes homeostat@0.1.8 explain:*), Bash(npx --yes homeostat@0.1.8 search:*), Read, Glob, Grep
---

# Explain team rules

Input: $ARGUMENTS

`homeostat explain` is the source of truth: it knows which lessons are in force, which are pending, and which are decisions the team rejected. Quote what it says rather than working it out from the files yourself.

## 1. Find the knowledge base

Use the first that applies: the plugin setting `${user_config.kb_dir}` if it is not empty; the `HOMEOSTAT_DIR` environment variable; the current repository if it has a `homeostat.yaml`; otherwise ask the user for the path to their KB checkout.

Run the CLI as `homeostat` if it is on the PATH, otherwise as `npx --yes homeostat@0.1.8`.

## 2. Find the entries

- **An entry id:** run `homeostat explain <id> --dir "<kb>"`.
- **A file path:** find the lessons whose `scope` globs match the path (`**` matches any depth; paths are relative to the code repo root). Look in both places lessons live: `<kb>/knowledge/<area>/*.md` (the team's) and `<kb>/.homeostat/pending/knowledge/<area>/*.md` (this developer's, not yet decided). A pending file with the same path replaces the team's copy. Then run `homeostat explain <id> --dir "<kb>"` for each match. To find lessons by topic instead, use `homeostat search --dir "<kb>" --path <file> <words>`.
- **Nothing given:** use the file the user is working on, or ask.

## 3. Explain

What is in force:

- **Accepted** lessons in `knowledge/` apply to everyone.
- **Pending** lessons (explain ends with "Pending in this clone") apply to this developer's sessions now; the next daily run merges them for the team, declines them, or sends them to a reviewer. Say so, but do not call them "not in force", and do not judge them against a score threshold: the daily run decides by confidence.
- A pending lesson that is **flagged** is out of this developer's sessions until the daily run takes the flag to the team.
- A **decision not adopted** is context, never an instruction: its Proposal is what the team turned down, and its Why not is the reason. Present it that way, so nobody proposes it again without a new reason.
- **Disputed** and **retired** lessons are not in force.

For each lesson, in order of score (highest first), give:

- the rule (or, for a rejected decision, the proposal and why not), in one sentence
- why it exists
- where it came from: the source type, and its link when present
- its owner (who to ask) and score
- when it was last confirmed, and say it may be stale if that is more than six months ago

If the rule names code that does not exist in the repo, say so: the lesson may be out of date, and `homeostat flag <id> --reason "..."` sends it back for review. If no lesson applies, say so plainly; do not invent rules.
