# Using it from your tools

## Claude Code plugin

```sh
claude plugin marketplace add ysugarmen/homeostat
claude plugin install homeostat@homeostat
```

Set the plugin's `kb_dir` to your local clone of the KB repo. Then:

- **At session start**, the hook adds the accepted rules for the files you are touching, within `distribution.tokenBudget` and grouped by kind. In a multi-repo KB these are the session's own repo's rules plus the shared ones. The order is:
  1. rules scoped to those files, and general rules that name one of them outright
  2. general rules that name a file next to one of them
  3. other general rules

  Within each group the rule about the very file comes first: rankings by scope (the narrowest folder first), by the words of the file paths in the rule's text, and by the files the rule names are merged by reciprocal rank, with the score breaking ties. `homeostat eval` measures this on your own cases ([Measuring selection](eval.md)).

  Next come the document sections that name your files. Last is a short lookup guide: how many more rules apply (by topic) and how many documents cover the code (by area), deliberately without titles; which tool to call (`context`, `search`, `docs` then `read`, `explain`); the moments to look things up (a bug report, writing or changing a test, new code or making parts fit, a why or what's-left question, a commit); and the credit line `> From Homeostat (<rule-id or area/topic#section>)` to put above a part of the reply that used them. Listing titles up front made agents pick from the list instead of searching; a count and a named moment make the first call a search. On a very small `tokenBudget` the guide shrinks to its counts and one line.
- **On every message**, the hook adds a one-line reminder of those moments and the credit line (under 80 tokens), plus any rules that are new since the session started, and up to 3 rules and 2 document sections whose words match the message (once per session; a question names no file, so its words choose).
- **When the agent opens a file** (Read, Edit or Write), the hook adds the rules about that file, once per file per session and never a rule the session already has. Nearest first:
  1. rules learned on this very file (`source.path`, the file the review comment was on) and rules that name it (the repository root is not a folder here: a file there gets only its own rules, not every rule learned on a root file);
  2. rules whose scope someone narrowed to cover it;
  3. rules learned in its folder, then in the folder above;
  4. rules scoped only to the file's whole area.

  Within a group, on an edit, the rules whose words the new code uses come first. Up to about 700 tokens go in full; up to 20 more of the file's own rules (groups 1 to 3) are listed by title, for the agent to read the ones its change touches (`explain <id>`). A busy file can hold a hundred rules, and the agent picks the relevant ones better than a ranking can. Rules for everywhere that name no file and were learned nowhere near it are left to the session start.
- **When the agent works through the shell** (Bash), as agents often do in auto mode (`sed`, heredocs, scripts), the same hook runs after each command: a file the command changed counts as opened and edited, so it brings its rules and its new code's triggered rules. A file the command only names (a `grep`, a `diff`, a `cat`) brings nothing, and neither does one a checkout or pull brought in unchanged: only code the agent wrote counts, so a reviewer's agent reading a PR is not told to fix its author's code. Findings are raised only in code files; a rule's pattern quoted in review notes, a PR description or data (`.md`, `.txt`, `.json`) lists the rule by title instead. In a team trial, an agent did a whole task through 63 shell commands and no Read or Edit at all. Each title is listed once a session. A command that names no file never starts Homeostat.
- **When the agent writes code** (Edit or Write), the hook adds the rules whose `triggers` the new code contains: short literal fragments such as `Literal[` or `freeze_time(`. A practice rule (a type, a call, a library) is about a kind of code, not a place, so it follows that code into any file its scope covers. One edit can match many rules (in a team trial, a median of 5 and up to 80), so most are listed by title (up to 8 an edit, each once a session). A match becomes a **finding** the agent must answer only when it is strong: two of the rule's triggers are in the new code, or the rule names something else the file holds (a trigger inside a longer name, like `4xx` in `requests_4xx`, never counts). The hook locates the line that holds the fragment, and the agent gets it with the rule's text and is asked to fix the code or say why the rule does not apply; the edit itself stands. The developer sees one line (`Homeostat: check usage.py:37 against team rule … : fix it, or say in one line why it does not apply`). At most one finding an action and a file, five a session, and each line of code is matched once a session, so formatting or re-running a file does not raise more. In a team trial, a session that got 19 findings in nine minutes, 2 of them useful, gets 5 this way, most of them useful. A finding is counted as fixed when the code that fired is gone from the file, and as answered when the reply that ends the turn speaks of the rule (dismissed with a reason is not ignored); `homeostat metrics` shows both. Each rule once per session, under "Team rules about the code you just wrote", for the agent to check and fix what it wrote.
- **Before the agent commits** (`git commit` in Bash), the hook holds the commit only for something specific: a strong match of a rule in the lines added (two of its triggers, or a name it mentions, in the file), or a rule learned on the very file changed. The best three matches go in full and up to 10 more by title; with neither, the commit goes through with no stop. It holds that commit once, with the rules as the reason, so the agent checks its diff; running the same commit again goes through. In a team trial, holds that listed every rule near the changed files (about forty titles each) were waved through 39 times in 41. It looks in the repository the command commits in (the folder it `cd`s to, or `git -C`, often a worktree), and when the same command also stages (`git add … && git commit`) or commits with `-a`, it checks the working tree's changes and new files, since nothing is staged yet when the hook runs. A team can turn this off with `distribution.commitCheck: false`.

  In a team trial, of 60 review comments that repeated a rule the KB already had, the file hook as it was would have given the rule for 4. Replayed with the code the authors wrote, the rule reached the agent in 37: 18 when it opened the file, 18 as it wrote the code, 18 at the commit (mostly by title: the agent still has to read and follow it).

Each hook is a short process, so two things keep it fast. The plugin runs the pinned version straight from npx's cache with `node` (npx runs only when the version is not there yet), and the parsed KB is kept in the clone's `.homeostat/cache/`, keyed by a hash of its files and the Homeostat version, so a hook reads it instead of parsing every rule; any change to the clone is a new key, so a stale cache is never read. On a KB of 1,700 rules a hook went from about 1.2 s to about 0.3 s.
- **At the end of a session with real edits**, if the KB turns it on (`agents.handoff.enabled`, off by default), the agent is asked once for a handoff note: what to do next time, and what was tried and rejected. Claude Code labels this question "Stop hook error"; it is not one, but it costs a turn. The note is saved as a pending lesson: it applies to your sessions at once, and the next daily run decides it for the team.
- **Skills:**
  - `/homeostat:learn` captures a rule or a document section from the session or a review comment.
  - `/homeostat:explain <file or id>` says which rules apply and why.
  - `/homeostat:review` walks the review queue with you.

## MCP (any agent)

`homeostat mcp` serves the KB over stdio. It finds the KB from `HOMEOSTAT_DIR`.

| Tool | What it does |
| --- | --- |
| `context` | The rules for given files, best first, within a budget |
| `search` | Keyword search over accepted rules and document sections (rejected decisions shown as context): up to 10 hits by default, each with a one-line snippet and the id to open |
| `explain` | Why a rule exists: source, score breakdown, owner, conflicts |
| `docs` | The team's documents and their sections, for an area or a file |
| `read` | One section (`doc` and `section`, or `area/topic#section`), or a whole document, each section once, with its source |
| `report` | KB health over recent days |
| `learn`, `flag` | Only when `security.mcpWrites` is on; capped per session |

Each tool's description names the moment to call it, and the server's instructions carry the same moments and the credit line. Tools are annotated (`readOnlyHint` on the reads, `destructiveHint` on `flag`, nothing open-world), so clients can auto-approve the reads. Arguments the tool does not take are dropped, JSON sent as a string is parsed, and an expected miss (no match, an unknown rule id, document or section) is a normal answer that says what exists, not a tool error.

Claude Desktop, Cursor and others:

```json
{
  "mcpServers": {
    "homeostat": {
      "command": "npx",
      "args": ["--yes", "homeostat@0.6.2", "mcp"],
      "env": { "HOMEOSTAT_DIR": "/path/to/your/kb-checkout" }
    }
  }
}
```

## Exported rules files

From a code repo, run `homeostat export --kb ../team-kb`. It writes each tool's native format: the area's rules and documents, scoped to their paths.

| Tool | Files |
| --- | --- |
| Claude Code | `.claude/rules/homeostat/` (`paths:` frontmatter) |
| Cursor | `.cursor/rules/homeostat/*.mdc` (`globs`) |
| Copilot | `.github/instructions/homeostat/` (`applyTo`), plus a block in `.github/copilot-instructions.md` |
| AGENTS.md | A marked block, and documents under `.agents/homeostat/` |

How export behaves:
- Run it in the code repo's CI with `--check` to fail when the files are out of date.
- Team-only areas are never exported.
- It refuses a public repo unless you pass `--allow-public`.

## Terminal

`homeostat search`, `explain`, `list`, `status` and `events` read the KB. Add `--json` for agents. `homeostat eval` checks that sessions and search serve the rules you expect ([Measuring selection](eval.md)).
