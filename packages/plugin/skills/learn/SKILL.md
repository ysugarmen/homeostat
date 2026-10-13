---
name: learn
description: Capture a lesson from this session, or from a PR review comment, as a candidate entry in the team's kbx knowledge base. Use when the user corrects you on a team convention, says "remember this for the team", or passes a PR comment URL.
argument-hint: "[lesson or PR comment URL]"
allowed-tools: Bash(kbx learn:*), Bash(npx --yes kbx@0 learn:*), Read, Glob
---

# Capture a lesson for the team

Turn one lesson into a candidate knowledge entry with `kbx learn`. A reviewer accepts it later through a PR; you never mark it accepted.

Input: $ARGUMENTS

## 1. Find the knowledge base

Use the first that applies:

1. The directory in the `KBX_DIR` environment variable.
2. The current repository, if it has a `kbx.yaml` at its root.
3. Otherwise ask the user for the path to their local checkout of the KB repo. Do not guess.

Read its `kbx.yaml` to learn the member ids under `team.members` and the area names under `areas` (`core` always exists).

Run the CLI as `kbx` if it is on the PATH, otherwise as `npx --yes kbx@0`.

## 2. Draft the entry

One entry holds exactly one rule. If the input contains several, capture the most important one and offer to do the others next.

- **Title:** an imperative sentence of at most 80 characters, e.g. "Use the shared retry helper for outbound HTTP calls".
- **Rule:** one paragraph of at most 60 words saying what an agent must do. Concrete names (functions, paths, packages) beat general advice.
- **Why:** at most 100 words, the reason, so a future agent can judge edge cases.
- **Area:** the area whose paths the rule is about, or `core` if it applies everywhere.
- **Author:** the member id of the person the lesson came from. If the user is not obviously one of the members, ask which member they are.

Do not invent facts. If the lesson came from a correction in this session, the rule is what the user wanted instead, and the why is the reason they gave; ask for the reason if they gave none.

Show the draft to the user and wait for approval before writing it.

## 3. Write it

From a PR review comment URL (Bitbucket `#comment-N`, GitHub `#discussion_rN`), pass the URL first; the CLI fetches the comment, sets the source and works out the author:

```sh
kbx learn "<url>" --dir "<kb>" --title "<title>" --rule "<rule>" --why "<why>" --area <area>
```

Otherwise:

```sh
kbx learn --dir "<kb>" --title "<title>" --rule "<rule>" --why "<why>" --area <area> --author <member-id>
```

Add `--scope "<glob>"` (repeatable) only when the rule applies to narrower paths than the area. A URL needs `KBX_BITBUCKET_TOKEN` or `KBX_GITHUB_TOKEN`; if the CLI says the token is missing, tell the user which variable to set rather than retrying.

If the CLI reports validation errors, fix the draft (usually length) and run it again. Nothing is written until it passes.

## 4. Hand back

Tell the user the file that was created and its score, and that it needs committing on a branch and a PR to the KB repo. Offer to do the commit; do not push or open the PR unless they ask.
