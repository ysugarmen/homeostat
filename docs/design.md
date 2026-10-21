# homeostat — Market Research & Design Doc

> **Historical.** Written while building 0.1 (October 2026) and kept as the record of how Homeostat was planned. For how it works today, see [architecture.md](architecture.md) and the [guide](index.md); where they disagree with this page, they win.

Oct 13, 2026

> The public name is **Homeostat** (see *Naming*). Where this doc and [execution-plan.md](execution-plan.md) disagree, the execution plan wins.

## Executive summary

The market is real, early, and thinly capitalised: the closest direct competitor ([Packmind](https://packmind.com/)) has raised about $1.2M total and runs open-core, while the platform vendors have absorbed the easy half (session memory) but not the hard half (turning review feedback into scored, governed, cross-tool knowledge). That hard half is exactly what the pilot already does.

**Three findings**

1. **Anthropic has shipped the floor.** Claude Code now has auto-memory (learns from corrections) and org-level team memory sync. A product whose only value is "shared context across sessions" is dead on arrival.
2. **Nobody owns the feedback loop.** CodeRabbit captures learnings from review threads but tells teams to prune them manually every quarter and only feeds them back into its own reviewer. GitHub Copilot does not learn from feedback at all. Packmind distributes standards but does not mine PRs or score quality.
3. **Enterprises are shifting to build-over-buy** for thin AI tooling (Yegge, Software Survival 3.0). The sustainable shape is open source first, with a paid governance layer only once real pull appears.

**Recommendation:** ship homeostat as an open-source Claude Code plugin (skills + hooks + MCP server) within 4–6 weeks, built for the pilot team's own daily use, then add cross-agent distribution (Cursor, Codex, Copilot) via MCP. Treat a company as a later option, not the starting point.

## Competitive landscape

No player covers the full chain of capture, scoring, governance and cross-tool distribution. Sorted by how close each is to homeostat.

| Player | What it does | Captures from PR feedback | Scores / conflict-checks | Distributes to agents | Business model | Funding |
| --- | --- | --- | --- | --- | --- | --- |
| [Packmind](https://github.com/PackmindHub/packmind) | Scans repo, generates short "standards", writes them to .claude/rules, .cursor/rules, .github/instructions, .kiro/steering | No | No | Yes, multi-tool | Open-core; paid enforcement, SSO/SCIM | \~$1.2M (PitchBook) |
| [CodeRabbit](https://docs.coderabbit.ai/) | AI code review; "learnings" KB built from review threads; reads CLAUDE.md / AGENTS.md as criteria | Yes (review threads) | No; docs say prune manually each quarter | Only into its own reviewer | SaaS per seat | Series B ($60M, 2025) |
| Anthropic Claude Code | Auto-memory from corrections, CLAUDE.md hierarchy, .claude/rules, org team-memory sync, Projects with shared memory | Indirect (session corrections) | No | Claude only | Platform feature | n/a |
| [Unblocked](https://getunblocked.com/) | Context engine: code + Slack + Jira + PR discussions, served via MCP, CLI, code review | Yes (as retrieval, not curated rules) | No | Yes via MCP | SaaS | $20M Series A (2025) |
| BuildBetter | Canonical source generating CLAUDE.md / AGENTS.md, cross-agent session memory | No | No | Yes | SaaS | Undisclosed |
| GitHub Copilot review | Review with custom instructions files | Explicitly no learning | No | Copilot only | Bundled | n/a |
| Cursor BugBot | Bug detection on PRs | No | No | Cursor only | Bundled | n/a |
| [Swimm](https://swimm.io/) / Falconer | Docs-as-code kept current by CI | No | No | Partial | SaaS | Swimm \~$27M |
| Mem0, Zep, Letta, Hindsight | Generic agent memory layers | No | No | SDK | Open-core | Various |

Two adjacent signals worth watching: the official Claude marketplace already lists a plugin "to maintain CLAUDE.md, capture learnings and keep project memory current" ([marketplace](https://claude.com/marketplace/plugins)), and Slite now advertises detecting "knowledge drift" from merged PRs. Both are thin, single-tool features, not a governed pipeline.

## Gap analysis: what nobody owns

The wedge is the **feedback-to-knowledge loop**: the four capabilities below exist nowhere together, and the pilot deck already has a working version of each.

| Gap | Who gets closest | Why they stop | homeostat's answer (from the pilot) |
| --- | --- | --- | --- |
| Mine *accepted* review feedback (comment + resulting code change) | CodeRabbit | Captures the comment, not whether the author acted on it | +3 score only when the PR code actually changed |
| Quality scoring and auto-merge threshold | None | CodeRabbit asks humans to prune quarterly | Score ≥3 auto-merges when every safety gate passes (see [security.md](security.md) T1), 1–2 weekly review, conflicts always flagged |
| Conflict detection against existing knowledge | None | Rules files just accumulate | −2 on conflict, pipeline blocks the PR |
| Layered ownership: core vs area, permissions, CODEOWNERS | Packmind (governance tier, paid) | Not tied to who produced the knowledge | team.json + auto-generated CODEOWNERS |
| Cross-tool distribution | Packmind, Unblocked | Packmind has no capture; Unblocked is retrieval, not rules | Today Claude only; MCP + rules-file export is the next step |
| Agent handoff notes as a source (Yegge, Model Welfare) | None | Nobody treats session exits as knowledge events | Not yet built; cheap to add as a hook |

**Where homeostat is behind:** Packmind already writes to four rules-file formats; Unblocked already indexes Slack and Jira. Both are table stakes within a year and should be copied, not competed on.

## Yegge lens: survival levers applied to homeostat

Yegge's [Software Survival 3.0](https://yegge.ai/essays/software-survival-30/) formula, Survival ∝ (Savings × Usage × H) / (Awareness cost + Friction cost), is a useful design constraint. Each lever maps to a concrete homeostat decision.

| Lever | What it means for homeostat | Design decision |
| --- | --- | --- |
| Insight compression | One scored knowledge entry saves every teammate's agent from re-deriving it | Measure tokens saved per entry; surface it in the weekly digest |
| Substrate efficiency | Knowledge injected into every session costs context | Inject by area and by file path, never the whole base; cap at a token budget |
| Broad utility | Claude-only caps usage at Claude's share | MCP server + rules-file export to Cursor, Codex, Copilot |
| Friction / desire paths | Agents will guess tool names; make the guesses work | Log unknown MCP calls, implement the common ones; keep /learn a one-liner |
| Human coefficient | Trust decides adoption | Every entry carries source PR, score, owner, and a one-click "this is wrong" |
| Publicity | Nobody awards an unknown repo | Launch as a marketplace plugin with a public dogfood write-up |

From the other three essays: the [Hive Mind](https://yegge.ai/essays/the-anthropic-hive-mind/) piece validates full work-stream transparency (SageOx records every transcript) and "build for yourself" as the only reliable road to product-market fit. [The AI Vampire](https://yegge.ai/essays/the-ai-vampire/) warns that "agent memory" pitches are crowded and that enterprises are refusing SaaS renewals, which argues for open source first. [Model Welfare](https://yegge.ai/essays/model-welfare/) adds agent-written handoff notes as a knowledge source homeostat should capture alongside PRs.

## Design: Claude Code first, MCP second

Keep the two-repo shape from the pilot, package `homeostat` as a Claude Code plugin, and put the knowledge base behind an MCP server so the same curated entries reach every agent. The accent boxes are the two parts nobody else has: the quality pipeline and the MCP server in front of it.

&#91;embedded content: homeostat architecture · capture, pipeline, distribution\]

Feedback enters top-left, is scored top-right, lands in the repo, and flows back down into every agent and into humans through the digest.

### Plugin layout (phase 1)

- **Skills:** `/learn` (manual capture), `/homeostat-explain <file>` (why is this rule here, with source PR), `/homeostat-review` (walk the weekly queue).
- **Hooks:** `SessionStart` injects the relevant area's entries by file path within a token budget; `Stop` or `PreCompact` asks the agent for a handoff note and captures it as a low-score entry.
- **Scheduled agents:** the daily curator and weekly deep dive. ~~Moved into the plugin's hooks config.~~ **Superseded:** per the zero per-machine maintenance constraint in the execution plan, they run centrally (CI schedule or `up` on a shared box), never on a developer's laptop.
- **MCP server:** bundled in the plugin's `.mcp.json`, so installing the plugin is the whole setup.

### MCP tools to expose

| Tool | Purpose | Notes |
| --- | --- | --- |
| `homeostat_search(query, area?, path?)` | Return the top entries relevant to a task | The main read path for non-Claude agents |
| `homeostat_context(paths[])` | Entries for a set of files, under a token cap | What the SessionStart hook calls |
| `homeostat_learn(lesson, source, area)` | Propose an entry; opens the PR | Same path as `/learn` |
| `homeostat_explain(entry_id)` | Source PR, score history, owner, conflicts | Builds trust (human coefficient) |
| `homeostat_flag(entry_id, reason)` | Mark an entry wrong or stale; −2 and route to review | One-click correction |
| `homeostat_report(window)` | Digest data: new, merged, flagged, tokens saved | Feeds Slack |

Log every tool name an agent calls that does not exist (Yegge's desire paths) and implement the common ones.

### Rules-file export (phase 2)

A `homeostat export` command writes `.claude/rules/*.md`, `.cursor/rules/*.mdc`, `AGENTS.md` and `.github/copilot-instructions.md` from the same entries, matching Packmind's format list. This makes homeostat useful to a team even before they adopt the MCP server.

### Open design questions

- [ ] Should scores decay over time, or only on conflict and flags?
- [ ] Per-area token budget for injection: fixed, or proportional to files touched?
- [ ] Where do handoff notes live: their own `sessions/` folder, or merged into areas after a week?
- [ ] Bitbucket pipeline today; GitHub Actions and GitLab CI needed before open-sourcing?

## Product shape: standalone homeostat with a management dashboard

The plugin above is the entry point, but the product is a **single installable package** that ships the agent framework inside it and adds a control plane. One command (`homeostat up` or a Docker image) brings up three things: the curator agents, the knowledge-base pipeline, and a web dashboard. Nothing in the competitive table offers this combination; Packmind has a dashboard but no agents, CodeRabbit has agents but no team-level knowledge admin.

### What ships in the box

- **Agent runtime:** the daily curator, weekly deep dive, handoff-note collector and review assistant, bundled with their prompts and schedules, so nobody installs cron jobs by hand.
- **Knowledge pipeline:** scoring, conflict check, CODEOWNERS generation and the review queue, running as a service rather than a Bitbucket-only pipeline.
- **MCP server and rules export:** as designed in the previous section.
- **Dashboard:** the admin and visibility layer described below.

### Dashboard: setup and configuration

| Area | What the admin configures |
| --- | --- |
| Team and members | Invite members, assign to areas, set roles (senior, member; see execution plan step 1.3); replaces hand-editing `team.json` |
| Repos and sources | Connect Bitbucket, GitHub or GitLab repos; pick which PR streams and Slack channels the curator watches |
| Scoring rules | Edit the point values and the auto-merge threshold per area |
| Agent schedules | Turn each agent on or off, set frequency, choose model and token budget |
| Distribution | Which agents (Claude Code, Cursor, Codex, Copilot) receive knowledge, and how (MCP, rules files, both) |
| Notifications | Slack digest channel, cadence, and who gets review-queue pings |

### Dashboard: metrics and visibility

| View | Questions it answers |
| --- | --- |
| Agent liveness | Is each curator running, when did it last succeed, what did it cost in tokens, what failed |
| Per-member output | Entries proposed, merged and flagged per person; `/learn` usage; review-queue response time |
| Knowledge-base health | Entries per area, average score, age, conflicts open, stale entries, coverage of recently touched paths |
| Repo view | Which PRs produced knowledge, which code areas have none, acceptance rate of curator PRs |
| Impact | Tokens saved per session via injection, repeated review comments avoided, time from PR merge to entry live |

### Architecture note

The dashboard reads from the same `team-knowledge-base` repo plus an event log the agents write (runs, proposals, scores, flags). Keep the repo as the source of truth so teams can leave the dashboard and still own their knowledge; this is also the open-core line, with the agents and pipeline open source and the dashboard, SSO and hosted runtime as the paid tier.

### Open questions for the product shape

- [ ] Hosted by the project, self-hosted, or both at launch?
- [ ] Does the event log live in the repo (git-native) or in a small database next to the dashboard?
- [ ] Which agent runtime underneath: Claude Agent SDK only, or an abstraction that can also drive Codex and Cursor agents?
- [ ] ~~Per-member metrics: team or admins only?~~ **Decided:** the member view is visible to everyone. It is framed as contribution to the shared product (what each person's agents and `/learn` calls fed into the base), not as individual performance. No rankings, no per-person comparisons on the dashboard.

## Decision: ship as an open-source app first

The first aim is a public, self-hostable homeostat that any team can run. A company, hosted tier or paid dashboard features come later, only if external pull shows up. This section lists what the launch needs; most of it is unglamorous but it is what separates a repo from a project people adopt.

### Technical readiness

- [ ] Portable install: `docker compose up` or a single `npx homeostat` (TypeScript only; no Python package), with a 5-minute quickstart that works on an empty repo
- [ ] Git-host neutral: Bitbucket first (where the pilot runs), then GitHub (largest audience) and GitLab, all behind one interface
- [ ] Model neutral enough: Claude Agent SDK as the default runtime, with the provider key configurable so teams on other models are not blocked
- [ ] Secrets and permissions: tokens stay local, agents have least-privilege scopes, nothing phones home by default
- [ ] Tests and CI on the repo itself, so contributors can trust a green build
- [ ] A demo dataset or a public sample repo so people can see the dashboard without wiring their own

### Project hygiene

- [ ] Licence: Apache 2.0 or MIT for maximum adoption; AGPL only if the plan is to defend a hosted tier (decide before the first external star, changing later is painful)
- [ ] README with the problem, a screenshot of the dashboard, the 5-minute quickstart, and the architecture diagram from this doc
- [ ] CONTRIBUTING, code of conduct, issue templates, a public roadmap (the open questions in this doc are a good seed)
- [ ] Name and domain check: verify the GitHub org, npm name and a .dev or .sh domain are free for the chosen name
- [ ] Employer sign-off: confirm the pilot team's company is fine with the pilot code going public and agree on who owns the project

### Launch and community

- [ ] Dogfood write-up with the pilot's real metrics, published alongside the repo
- [ ] Submit to the Claude community marketplace and the Claude Code plugin lists; post on Hacker News, r/ClaudeAI, the Cursor and Codex forums
- [ ] A Discord or GitHub Discussions space, and a reply within a day on the first issues; early responsiveness is most of community building
- [ ] Track the proceed signal from the table below: 5+ external teams installing and opening PRs within 3 months

### Naming

The pilot's internal name cannot be the public name. **Decided (2026-10-13): Homeostat**, after Ashby's 1948 machine that rewired itself to stay stable, the way review feedback keeps a team's agents from drifting. The criteria it was chosen against: one or two syllables, typeable as a CLI command, says "team knowledge that agents keep" without saying "memory" (crowded) or "lore" (crowded: Lorekeep, Lorekeeper and several agent-memory projects already use it). Checked and taken: lorekeep, lorekeeper, reviewmind.

Shortlist to verify on GitHub org, npm, PyPI and a .dev or .sh domain:

| Candidate | Angle | Note |
| --- | --- | --- |
| **Tacit** | tacit knowledge made explicit | Strong meaning; likely contested, check `tacit-dev` / `tacitly` |
| **Gleanr** / **Glean** | gleaning lessons from reviews | "Glean" is a funded enterprise search company, avoid the exact word |
| **Sediment** | knowledge that settles out of PR flow and stays | Distinctive, unlikely taken, slightly slow-sounding |
| **Distilr** | distilling reviews into rules | Clear verb, check spelling variants |
| **Mergewise** | wisdom from merges | Descriptive, probably available with a suffix |
| **Keel** | what keeps the team steady underneath | Short, nautical, easy CLI (`keel learn`) |
| **Corpus** | the team's body of knowledge | Generic word, hard to own |

Decision rule: pick the one where the bare name is free on GitHub and npm; do not launch on a name that needs a `-ai` or `-dev` suffix to exist.

### What can wait

SSO, hosted runtime, billing, per-seat pricing, SOC 2. None of this matters until teams are using the open-source version and asking for it.

## Paths forward and next steps

Open source first, company only on pull. The two paths are not exclusive: Packmind, the nearest comparable, runs exactly this open-core sequence.

| Path | Upside | Risk | Signal to proceed |
| --- | --- | --- | --- |
| Open-source Claude Code plugin | Zero capital; the pilot team is the first user; marketplace distribution is free; fits the build-over-buy mood | Anthropic ships a similar feature; project stalls without maintainers | 5+ external teams install and open PRs within 3 months |
| Open-core startup (governance, SSO, hosted pipeline, analytics) | Enterprise budget exists for governance; Unblocked raised $20M on adjacent thesis | Investors fear absorption (Packmind's \~$1.2M says so); needs a cofounder and sales | Paid pilot request from a team of 30+ engineers |
| Stay internal to the pilot team | Keeps full focus on the day job | Learning stays private; no external validation | Only if the pilot metrics disappoint |

**Next steps**

- [ ] Finish the two-week pilot and write up the four metrics (quality, cross-team sharing, dev experience, noise) as a public post, due Oct 31, 2026
- [ ] Restructure the pilot as a Claude Code plugin with `.claude-plugin/plugin.json`, skills, hooks and a bundled MCP server
- [ ] Implement `homeostat_search`, `homeostat_context`, `homeostat_learn`, `homeostat_explain`, `homeostat_flag`, `homeostat_report`
- [ ] Add the handoff-note hook on `Stop` / `PreCompact`
- [ ] Add `homeostat export` for Cursor, AGENTS.md and Copilot instruction files
- [ ] Replace the Bitbucket-only pipeline with a portable script plus GitHub Actions template
- [ ] Publish to the Claude community marketplace and post the dogfood write-up
- [ ] Review the proceed signals on Jan 31, 2027 and decide on open source vs company

**Sources:** [Packmind repo](https://github.com/PackmindHub/packmind), [CodeRabbit docs](https://docs.coderabbit.ai/), [Unblocked](https://getunblocked.com/blog/best-engineering-knowledge-platforms-ai-coding-agents-2026/), [Claude Code features overview](https://code.claude.com/docs/en/features-overview), [Claude marketplace](https://claude.com/marketplace/plugins), Yegge essays linked above, the internal pilot deck (3/27/26).

**Step-by-step execution:** see [execution-plan.md](execution-plan.md)
