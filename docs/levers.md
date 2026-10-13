# Homeostat against Yegge's survival levers

Steve Yegge's *Software Survival 3.0* argues that software survives the agent era in proportion to (insight compression × substrate efficiency × broad utility × human coefficient) over (awareness cost + friction cost). This page checks Homeostat against each lever as built on 2026-10-14, and lists what is still open.

## 1. Insight compression

A Homeostat entry is a team's hard-won lesson, compressed: one rule of at most 60 words, the reason in at most 100, the review comment it came from, and a score. An agent that reads it does not have to rediscover the lesson by making the mistake again in review.

- The format forces compression: `validate` rejects a Rule over 60 words, a Why over 100, or a missing section.
- The curator only keeps feedback that changed the code (the +3 signal), and Claude declines threads with no lasting rule, so the KB holds lessons, not chatter.
- The deep dive merges near-duplicates, so the same insight is stored once.
- Verbs stay short and memorable: `learn`, `explain`, `flag`, `curate`, `deep-dive`, `up`.

## 2. Substrate efficiency

Everything that can run on a CPU does; a model is called only where judgment is needed.

| Job | Substrate |
| --- | --- |
| Choosing which rules a session gets | CPU: glob matching, score ranking, a greedy token budget (`selectEntries`) |
| Search | CPU: BM25-style keyword ranking (`searchEntries`), so agents can search as often as they like |
| Conflict and duplicate detection | CPU: deterministic checks (`detectConflicts`); a model only judges contradictions in the weekly deep dive |
| Scoring, validation, CODEOWNERS, export | CPU |
| Token counts | CPU: cached in each entry (`tokens`), so the hook never re-counts |
| Drafting a rule, merging two, judging a contradiction | Claude, one structured call each |

Token spend is bounded where it lands on every session:

- Injection stays under `distribution.tokenBudget` and Claude Code's 10,000-character cap, falling back to the Rule alone before dropping an entry.
- Only path-relevant and global rules are injected, never the whole base.
- The Claude Code runtime strips its own context for agent calls (own system prompt, no tools, MCP, skills or settings): about 1k input tokens per call instead of about 186k measured with the full interactive context.

Deliberate trade-off: token counts use `js-tiktoken` (cl100k) offline rather than the exact Messages API `count_tokens`, because the session hook must stay fast and offline. Counts are approximate and used only for budgeting.

Open: the curator could submit its drafts through the Message Batches API at half the cost, since nothing waits on it; worth doing once a team runs it at volume.

## 3. Broad utility

The same entries reach every agent a team uses, on either git host:

- Claude Code: plugin hooks (session start), skills, and the MCP server.
- Any MCP client (Claude Desktop, Cursor, Codex, ...): `homeostat mcp`.
- Cursor, Copilot and every AGENTS.md reader: native rules files from `homeostat export`.
- Bitbucket and GitHub providers behind one interface.

Open: a GitLab provider (named in the design doc); a public `homeostat` package on npm so `npx` works everywhere.

## 4. Publicity (awareness cost)

Agents have to know the tool exists and when to reach for it:

- The MCP server sends `instructions` telling any connected agent to call `context` before editing code, and when to `learn` or `flag`.
- The session-start hook puts the rules in context directly, so awareness is not needed for the main path.
- [`llms.txt`](../llms.txt) at the repo root describes the tool in the compact form agents and their tooling read.
- Tool and command descriptions are written for agents: what it does, in under 200 characters.

Open: the Claude Code marketplace submission and a public launch (Phase 6).

## 5. Minimizing friction (desire paths)

"Make their hallucinations real": wherever agents guess, the guess works.

- MCP: common guessed tool names (`get_rules`, `remember`, `list`, `kb.search`, ...) and argument spellings (`q`, `entry_id`, a single `file` for `paths`) are accepted. An unknown name gets the real tool list and the closest match. Every guess is logged, and the dashboard's *Desire paths* page shows which ones keep coming back, so they can become real tools.
- CLI: the commands agents reach for exist, with aliases: `search` (`find`), `explain` (`show`, `why`), `list` (`ls`), `status` (`report`, `health`), `learn` (`add`, `remember`), `validate` (`check`, `lint`), `events` (`log`). Every read command has `--json`, and an unknown command gets a suggestion. The short alias `homeo` also works.
- Errors say what to do next: which token variable to set, which flag is missing, how to point at the KB, the closest entry id.
- Capture costs the agent nothing: the Stop hook hands it the exact `learn` command for a handoff note.

Open: Claude Code asks once before an MCP tool runs; the plugin cannot pre-approve its read-only tools, so the README tells users which to allow.

## 6. The human coefficient

People trust rules they can trace to a person and a decision:

- Every entry carries its source (the review comment link), its author, an owner who answers for it, and a score whose breakdown `explain` shows.
- Nothing changes the KB without a human: the curator, the deep dive, handoff notes and flags all arrive as pull requests; CODEOWNERS routes them to the right reviewers.
- One-step correction: `flag` (CLI or MCP) costs an entry 2 points and sends it back to review.
- The members page shows contribution to a shared product, alphabetically, never as a ranking, as the design doc decided.

## Currency (checked 2026-10-14)

- Dependencies: every package is at its latest release (`pnpm outdated` is clean), including `@modelcontextprotocol/sdk` 1.32.1 and `@anthropic-ai/sdk` 0.133.
- CI actions: latest majors (checkout v7, setup-node v7, pnpm/action-setup v6), pinned to commit SHAs.
- Runtime: Node 24 LTS in CI and the Docker image.
- Model: the agents default to `claude-opus-5-5` at `medium` effort, configurable per agent, with the server-side refusal fallback on the API runtime.
