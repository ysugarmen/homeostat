---
name: learn
description: Capture a lesson from this session, or from a PR review comment, as a candidate entry in the team's homeostat knowledge base. Use when the user corrects you on a team convention, says "remember this for the team", or passes a PR comment URL.
argument-hint: "[lesson or PR comment URL]"
allowed-tools: Bash(homeostat learn:*), Bash(npx --yes homeostat@0.3.2 learn:*), Read, Glob
---

# Capture a lesson for the team

Turn one lesson into a knowledge entry with `homeostat learn`. It is saved in the developer's clone (`.homeostat/pending/`, git-ignored) and applies to their sessions at once. The next daily run decides it for the team: it merges confident lessons, declines weak ones, and sends the rest to a reviewer. You never mark a lesson accepted, and nobody needs to commit it or open a PR.

Input: $ARGUMENTS

## 1. Find the knowledge base

Use the first that applies:

1. The plugin setting `${user_config.kb_dir}`, if it is not empty.
2. The directory in the `HOMEOSTAT_DIR` environment variable.
3. The current repository, if it has a `homeostat.yaml` at its root.
4. Otherwise ask the user for the path to their local checkout of the KB repo. Do not guess.

Read its `homeostat.yaml` to learn the member ids under `team.members`, and the areas and topics:

- **One code repo:** areas under `areas`, topics (if any) under `topics`.
- **Several repos** (a `repos` key): this session's repo is the one whose `source` matches the current checkout's git remote. Its areas are under `repos.<name>.areas` and its topics under `repos.<name>.topics`; shared rules for every repo use `topics` at the top level.

`core` always exists.

Run the CLI as `homeostat` if it is on the PATH, otherwise as `npx --yes homeostat@0.3.2`.

## 2. Draft the entry

One entry holds exactly one rule. If the input contains several, capture the most important one and offer to do the others next.

- **Title:** an imperative sentence of at most 80 characters, e.g. "Use the shared retry helper for outbound HTTP calls".
- **Rule:** one paragraph of at most 60 words saying what an agent must do. Concrete names (functions, paths, packages) beat general advice.
- **Why:** at most 100 words, the reason, so a future agent can judge edge cases.
- **Area:** the area whose paths the rule is about, or `core` if it applies everywhere in the repo. In a KB for several repos, the rule belongs to this session's repo (the CLI works that out from the checkout or the PR URL); add `--shared` only when it holds in every repo the team owns.
- **Topic** (when the KB has topics): the listed topic that fits best, passed as `--topic <name>`. If none fits, leave it out: the CLI picks the closest by its words, else `general`.
- **Author:** the member id of the person the lesson came from. If the user is not obviously one of the members, ask which member they are.
- **Kind** (optional, `--kind`): `convention`, `anti-pattern`, `review-lesson`, `migration`, `legacy`, `tech-debt`, `practice` or `decision`. When the team discussed something and decided **against** it, use `--kind decision --not-adopted`: the rule is the proposal, the why is why not. Agents then see it as context and stop re-proposing it, but never as an instruction.

Do not invent facts. If the lesson came from a correction in this session, the rule is what the user wanted instead, and the why is the reason they gave; ask for the reason if they gave none.

Show the draft to the user and wait for approval before writing it.

**A fact about how the system works** (a renamed service, a finished migration, a contract between repos) belongs in a team document rather than a rule. Find them under `<kb>/knowledge/<area>/docs/`, or `<kb>/knowledge/<repo>/<area>/docs/` in a KB for several repos (Glob), or with the MCP `docs` tool. Then patch exactly one section:

```sh
homeostat learn --dir "<kb>" --doc <area>/<topic> --section <id> --append --text "<the new fact>"
```

Use `--append` to add to a section. Drop it to replace a section's text when it is now wrong, keeping every sentence that is still true. Use `--heading "<Heading>"` with a new `--section` id to add a section. Never rewrite a whole document.

## 3. Write it

From a PR review comment URL (Bitbucket `#comment-N`, GitHub `#discussion_rN`), pass the URL first; the CLI fetches the comment, sets the source and works out the author:

```sh
homeostat learn "<url>" --dir "<kb>" --title "<title>" --rule "<rule>" --why "<why>" --area <area> [--topic <topic>]
```

Otherwise:

```sh
homeostat learn --dir "<kb>" --title "<title>" --rule "<rule>" --why "<why>" --area <area> --author <member-id> [--topic <topic>]
```

Add `--scope "<glob>"` (repeatable) only when the rule applies to narrower paths than the area. Run the command from the session's working directory, so the CLI can tell which repo the rule is for; `--repo <name>` overrides it. A URL needs `HOMEOSTAT_BITBUCKET_TOKEN` or `HOMEOSTAT_GITHUB_TOKEN`; if the CLI says the token is missing, tell the user which variable to set rather than retrying.

If the CLI reports validation errors, fix the draft (usually length) and run it again. Nothing is written until it passes.

## 4. Hand back

Tell the user the lesson's id and score, and pass on what the CLI said: it applies to their sessions now, and tomorrow's daily run decides it for the team. If the CLI printed warnings, pass those on too. There is nothing to commit or push: the plugin's session hooks send the lesson to the daily run in the background.
