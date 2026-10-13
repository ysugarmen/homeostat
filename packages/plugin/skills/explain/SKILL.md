---
name: explain
description: Explain which kbx knowledge base rules apply to a file and why each exists, with its source PR, score and owner. Use when the user asks why a team rule exists or what rules cover a file.
argument-hint: "<file path or entry id>"
allowed-tools: Read, Glob, Grep
---

# Explain team rules

Input: $ARGUMENTS

## 1. Find the knowledge base

Use the first that applies: the `KBX_DIR` environment variable; the current repository if it has a `kbx.yaml`; otherwise ask the user for the path to their KB checkout.

Entries live at `knowledge/<area>/<id>.md`: YAML frontmatter, then `## Rule`, `## Why` and an optional `## Example`.

## 2. Find the entries

- **An entry id:** read `knowledge/*/<id>.md`.
- **A file path:** read every entry and keep those whose `scope` globs match the path (`**` matches any depth). Paths are relative to the code repo root.
- **Nothing given:** use the file the user is working on, or ask.

Only `status: accepted` entries are in force. Mention candidates and disputed ones separately, clearly labelled as not in force.

## 3. Explain

For each entry in force, in order of `score` (highest first):

- the rule, in one sentence
- why it exists, from the Why section
- where it came from: `source.type`, and `source.url` as a link when present
- its owner (who to ask) and score
- `lastConfirmed`, and say it may be stale if that is more than six months ago

If `conflictsWith` is set, say which entries it conflicts with and that it is disputed. If no entry applies, say so plainly; do not invent rules.
