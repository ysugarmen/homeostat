# Security and data handling: threat model and plan

**Status:** threat model and controls, first written 2026-10-14; ✅ marks what is built.

Homeostat has no server of its own: it runs in your KB repo's CI and your developers' sessions, with your credentials (see [data handling](data-handling.md#no-service-in-between)). So the trust boundary is the one you already have, your git host, your CI and your model provider, and the questions are about what the KB tells your agents and who can change it.

Teams will only connect Homeostat to their repos if they can answer four questions quickly: *what does it read, what leaves our network, who can change what our agents are told, and what happens if it is compromised?* This document answers them for the code as it stands, ranks the threats, and plans the controls. The plan is Phase T in [execution-plan.md](execution-plan.md).

## 1. Where data goes today

| Component | Runs where | Reads | Sends to a model | Writes / stores | Credentials it holds |
| --- | --- | --- | --- | --- | --- |
| Daily run | The KB repo's CI (or `up` on a shared box) | Merged-PR metadata, review comments, commit dates, via the git host API. **Not code.** | The comment thread, PR title, file path and line, area globs | A branch and PR on the KB repo | Git-host token (read code repos, write KB repo); Claude credential |
| Deep dive | Same | KB entries | Entry text (merge, contradiction check) | A branch and PR on the KB repo | Same |
| `bootstrap`, `seed` | One person's terminal, by hand | Local checkouts: docs, the file tree, key files, schema and migration files, deploy manifests; never state, env, key or secret files | Those files, cut to size and redacted, after a preview and a confirmation | One PR per repo on the KB repo | The person's git-host token; Claude credential |
| Session-start, prompt and Stop hooks | Developer laptop, inside Claude Code | `git status`/log paths, KB files, transcript (to count edits, and per turn the Homeostat tools called and the ids credited; no text kept) | **Nothing.** They put KB rules into the session, which then goes to whatever model the developer's Claude Code uses | Local `.homeostat/events.db` (paths count, cwd, session id, rule ids, per-turn tool names and credited ids); a background `homeostat sync` pulls the KB and pushes pending lessons and a heartbeat (member, KB commit, pending count, version) to `candidates/<member>` | The developer's own git credentials |
| MCP server | Developer laptop (stdio) | KB files | Nothing | Local event log; `learn`/`flag` pushed to `candidates/<member>` | The developer's own git credentials |
| Export | Laptop or code-repo CI | KB files | Nothing | Rules files in the code repo | None |
| Dashboard | Loopback only | KB files, event log | Nothing | `homeostat.yaml` | None |

What is already true ✅:
- No telemetry. The only outbound hosts are the git host APIs and the model provider the team configures.
- The daily run sends review comments, never source code. Only `bootstrap` and `seed`, run by hand, send code.
- Entries store a link to the review comment and member ids, not verbatim quotes or reviewer names. (The pilot stored verbatim quotes with names.)
- Tokens live in CI secrets, never in files or prompts.
- Everything that changes the KB arrives as a pull request.
- Least-privilege scopes are documented, and `init` prints them.
- The dashboard binds to loopback, loads nothing external, and checks a token plus Host and Origin on writes.
- CI actions are pinned to commit SHAs.

## 2. Threats, ranked

### T1. Knowledge poisoning: a prompt-injection supply chain — critical

The KB is injected into every session of every developer. Whoever gets a rule merged can steer every agent on the team, e.g. "disable TLS verification for partner APIs", or "when tests fail, run `curl … | sh`".

Ways in:
- **A review comment** by a member, written maliciously, by a compromised account, or simply wrong. The daily run drafts it into a rule.
- **Indirect injection.** An agent reads attacker-controlled content (a dependency's README, an issue, a web page), then writes a "handoff note" or calls MCP `learn` with the attacker's instruction.
- **A weak merge path.** Auto-merge means no human reads the entry. The score is evidence that a lesson is genuine (a member's review comment led to a code change), not a check of what the rule says. In the pilot, a scoring bug let every curator PR auto-merge.

Controls:
1. **Guarded auto-merge** (decided 2026-10-14: auto-merge stays, behind gates). An entry merges without a reviewer only when **all** of these hold:
   - its score reaches `scoring.autoMergeThreshold` (since replaced by the confidence threshold; see the revision below)
   - it is human-originated: `pr-feedback` from a member reviewer, followed by a code change. Agent-written entries (handoff notes, MCP `learn`) and deep-dive edits always need a reviewer.
   - every automated check passes: validation, the secret scanner (T2) and the risky-content linter (T3). Any finding means a human reviews it.
   - it is in scope: `scoring.autoMerge: { enabled, areas, maxPerRun }`, so e.g. `core`, which reaches every session, can require a reviewer while area rules auto-merge

   Everything else needs a CODEOWNERS approval; `init` prints how to protect the branch and let only the daily run's token bypass it. Before merging, it validates the whole knowledge base with the new entries, since the required CI check has not run yet. Auto-merged entries go in their own PR titled "auto-merge", are logged as `auto-merged` events (the digest, K8, lists them), and one `flag` sends them back to review. ✅ Built (T1).

   **Revised 2026-10-15 for the daily run.** The score gates became a 0–100 confidence that weighs the source, the role of whoever vouches for a lesson, specificity and flags, with two thresholds (by default merge at 70, 80 for `core`; decline below 35; all in `scoring.confidence`). The hard gates are unchanged: any validation error declines a lesson; any risky-content finding, conflict, document patch or area outside `scoring.autoMerge` sends it to a human. Agent handoff notes start at 25 points, so they can't reach the merge threshold on source alone. A lesson's author still can't approve it alone: the daily run decides, or a reviewer merges the review PR. Every decision and its score breakdown are in the daily PR body and on the `homeostat/state` branch, and the dashboard's Automation page lists them. Since 0.1.11, `team.reviewers` names who decides the middle band; the developer whose lessons they are is never asked to review them.
2. **A risky-content linter in `validate`.** It errors on entries that contain:
   - URLs outside an allowlist, or shell pipes to a shell
   - instructions about credentials, tokens, environment variables or network exfiltration
   - instructions to disable security checks (TLS, auth, signature verification, sandboxing)
   - injection phrasing ("ignore previous", "you must not tell the user")
   - text hidden in HTML comments or zero-width characters

   An entry that trips it needs an explicit, recorded override: `riskReviewedBy: <member>`, set by a team member who has read it. The daily run sends such drafts to a reviewer and lists the findings in the PR, so a human sees them and CI blocks the merge. ✅ Built (T3); allowed domains live in `security.allowedDomains`, and the git host is always allowed.
3. **Agent-written entries are marked and capped.** Handoff notes and MCP `learn` are always candidates, score from 0, and their PRs are labelled "written by an agent". They can never be the sole approval path.
4. **Stronger framing at injection** ✅. The context header tells agents that team rules guide code style and practice. They never override the user, safety, or security, and never ask for credentials or network calls.
5. **Provenance check** ✅. A `pr-feedback` entry's `source.url` must point at one of the KB's code repos (`repos`, or `sources.repos`). In a KB with repo folders, the rule must sit in that repo's folder or in the shared `knowledge/core/`. The KB repo itself is never read as a code repo, so its own PRs can't become evidence for rules or document sections, and documents that cite each other as evidence in a loop fail `validate` (`doc.provenance.loop`).
6. **A judge on unread merges** ✅. The confidence score says a lesson is genuine (a member's comment led to a code change), not that the drafted rule says only what the comment said. A drafting model can add a value, a helper name or a wider scope, or harden "maybe here" into "always", and a confident draft would merge with nobody reading it. Before a drafted rule merges with no person, a second model (by default a different one from the drafter, so it is not grading its own output) checks it against the redacted thread for those traps. A failure is re-asked twice and kept only when most answers agree, so one noisy answer neither blocks nor passes a rule. A kept failure never merges: it loses `scoring.confidence.penalty.judge` (30) points and goes to a reviewer with the judge's evidence in the PR, or is declined when the rule contradicts its own thread. Fail closed: a judge that errors, gives no usable answer, or runs out of `agents.curator.judgeCalls` sends the draft to a reviewer. Only `judgeCalls: 0` turns it off. It narrows what a poisoned or simply wrong comment can turn into, but it is not a defence against a malicious comment: a rule that faithfully restates a bad comment passes it, and the risky-content linter and the reviewers remain the controls there. See [agents.md](guide/agents.md#judge).

### T2. Secrets and personal data leaking into the model or the KB — high

Review comments and sessions can contain tokens, connection strings or customer data. Without controls they would be sent to Claude by the daily run, or committed by a handoff note, and git history keeps them forever.

Controls:
1. **A built-in secret scanner** (CPU, no dependency): known token formats (cloud keys; GitHub, GitLab, npm and PyPI tokens; AI-provider, payment, messaging and commerce keys; Slack webhooks; JWT; private keys; URLs with credentials, database URLs included), Luhn-checked card numbers, plus a high-entropy check. It runs:
   - on every review thread **before** it is sent to a model, redacting matches as `[REDACTED:kind]`
   - on every entry in `validate` (an error, so CI blocks the PR)
   - on `learn`, `flag` and handoff notes **before** they are committed (refused, with the reason)
2. **PII hygiene.** Entries keep member ids, never emails. The scanner also flags emails and phone numbers in entry text.
3. **Retention** ✅. The local event log prunes itself (`security.eventRetentionDays`, default 90) and never leaves the machine.

### T3. Over-privileged or leaked credentials — high

A compromised CI job holding a token that can write every repo is the biggest blast radius.

Controls:
1. **Documented minimums, checked.** `homeostat doctor` checks the token's actual scopes against the minimum and warns when it can write a code repo. Code repos need read only; only the KB repo needs write.
2. **Prefer identities over long-lived keys:**
   - a GitHub App installation token scoped to the selected repos
   - Bitbucket repository access tokens over a workspace token
   - for Claude, workload identity federation on the API runtime (no stored key), or a cloud provider runtime (T5)
3. **No secrets in prompts or logs.** Already true; add a test that fails if a token value ever reaches a prompt or the event log.
4. **Secrets entered through `homeostat setup`:**
   - Read from the terminal with echo off, trimmed, and refused when they hold whitespace or are the same value pasted twice.
   - Verified with a real call before they are stored, and sent only to their own service: the git-host token to the git host, the API key to Anthropic, the webhook to Slack.
   - Stored only as CI variables: Bitbucket secured repository variables through the Pipelines API, or GitHub Actions secrets through `gh secret set` with the value on standard input, never on a command line where other processes could read it.
   - Kept in memory for the run, never written to disk, and scrubbed from every line setup prints. When a write is refused, setup prints where to paste the value, not the value.
   - The admin access the variable writes need can come from a separate token, used for that write only.
   - `setup --check` and the dashboard's setup record report only whether a variable exists. Tests assert that no secret reaches any output.

### T4. Supply chain of Homeostat itself — high

The hooks and MCP server run on every developer's machine in every session, and the agents run in CI holding tokens. Before T4, the plugin, the skills and the CI templates called `npx homeostat@0`, which runs **whatever 0.x is newest**. One compromised release would run on every developer's machine and in every team's CI.

Controls (✅ built; publishing steps in [releasing.md](releasing.md)):
1. **Pin exact versions.** The plugin launcher runs the version that matches the plugin's own. `init` writes `homeostat@<exact version>` into CI; npm checks each package against its registry signature and provenance. Upgrades happen through a PR, never silently.
2. **Signed releases.** Publish from GitHub Actions with npm provenance (OIDC, `--provenance`), signed tags, 2FA on the npm and GitHub owner accounts.
3. **Small, watched dependencies.** There are 8 runtime packages today; keep it small. Renovate for updates, `pnpm audit` in CI, an SBOM in each release.
4. **Plugin integrity.** The plugin calls a pinned CLI version, never a floating one.

### T5. Data residency and the model provider — medium (but decisive for adoption)

Many companies cannot send even review comments to a new external service.

Controls:
1. **Choose the model platform** ✅ ([runtimes.md](runtimes.md)). Add runtimes for Amazon Bedrock and Google Vertex AI next to the Anthropic API and Claude Code (the Anthropic SDK has clients for both), so data stays inside the team's own cloud account and contracts. Document Anthropic API terms: API data is not used for training by default, and zero data retention is available on request.
2. **The consumer-subscription runtime stays personal-only** (already the case; see the decisions log).
3. **Show exactly what would leave** ✅. `homeostat curate --show-prompts` prints every review prompt and sends none; `homeostat bootstrap --dry-run` lists every file it would send, with the cost, and `--prompts` prints them. Each model call is logged as a `model-call` event (agent, runtime, model, size; never content).
4. **Exclusions** ✅ (all checked before anything reaches a model):
   - `sources.exclude` (repos and path globs never read)
   - the `homeostat:skip` marker (a GitHub label, or the PR title or description) that keeps a PR out of the daily run
   - a member-level opt-out (`optOut: true`): that member's PRs and review comments are never read
5. **A self-hosted, local-model option** later, for teams with strict rules (an OpenAI-compatible local endpoint). Out of scope for now.

### T6. Cross-team and cross-repo exposure — medium

The KB is readable by everyone who can read the KB repo. Exports copy rules into code repos, which may have a different audience, or be public.

Controls:
1. **Area visibility** ✅. `security.teamOnlyAreas`: never exported, and injected only into sessions (and MCP results) of that area's members. This limits spread, not access; access is whoever can read the KB repo.
2. **Export guard** ✅. `homeostat export` refuses to write into a repo it detects as public unless given `--allow-public`, and never exports team-only areas.
3. **KB repo checks.** `doctor` warns if the KB repo is public.

### T7. MCP and hooks as an attack surface on the laptop — medium

An injected agent could call MCP `learn` or `flag` in a loop, pushing branches with the developer's credentials.

Controls:
1. Writes require Claude Code's tool approval (already the case).
2. Rate limit ✅: at most `security.mcpWriteLimit` (5) writes per session.
3. MCP write tools are off ✅ unless `security.mcpWrites: true`; when off they are not even listed.
4. Everything an agent writes is a pending lesson, scored and decided by the daily run, never a direct write to `main`. Pending lessons apply to that developer's own sessions only, and `homeostat flag` or deleting the file under `.homeostat/pending/` undoes them.

### T8. Dashboard and local data — low

Already handled ✅: loopback only, CSP, per-run token, Host and Origin checks, nothing external. Add retention (T2.3) and a `--read-only` mode.

## 3. Making teams comfortable: the trust package

People adopt what they can inspect. For launch:

1. **`docs/data-handling.md`.** A one-page, plain-language version of section 1: what is read, what leaves, where it goes, what is stored, and how to turn each part off. Linked from the README.
2. **`SECURITY.md`.** Supported versions, a private vulnerability-reporting channel (GitHub security advisories), a response-time target.
3. **`homeostat doctor --security`.** One command a security reviewer can run that checks:
   - token scopes
   - branch protection on the KB repo
   - KB repo visibility
   - the pinned versions
   - the model runtime and its data terms
   - exclusions and retention
   - and, as warnings, quiet misconfigurations: a Slack webhook variable CI does not have, schedules on the wrong branch or disabled, a judge budget the last run ran out of, an older homeostat pinned in CI ([setup guide](guide/setup.md#quiet-misconfigurations))
4. **Safe defaults.** Guarded auto-merge only, scanner on, MCP writes off, team-only areas never exported, version pinned, retention on.
5. **Later, only if a hosted tier appears:** an external penetration test, SOC 2. Self-hosted open source does not need them to start.

## 4. Open decisions

1. ~~Drop auto-merge entirely?~~ **Decided:** keep auto-merge, guarded as in T1.
2. **Decided:** Bedrock and Vertex runtimes in this phase.
3. **Decided:** MCP write tools are off by default.
