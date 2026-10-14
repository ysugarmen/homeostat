# Security and data handling: threat model and plan

**Status:** draft for review, 2026-10-14. Nothing here is built yet unless marked ✅.

Teams will only connect Homeostat to their repos if they can answer four questions quickly: *what does it read, what leaves our network, who can change what our agents are told, and what happens if it is compromised?* This document answers them for the code as it stands, ranks the threats, and plans the controls. The plan is Phase T in [execution-plan.md](execution-plan.md).

## 1. Where data goes today

| Component | Runs where | Reads | Sends to a model | Writes / stores | Credentials it holds |
| --- | --- | --- | --- | --- | --- |
| Curator | The KB repo's CI (or `up` on a shared box) | Merged-PR metadata, review comments, commit dates, via the git host API. **Not code.** | The comment thread, PR title, file path and line, area globs | A branch and PR on the KB repo | Git-host token (read code repos, write KB repo); Claude credential |
| Deep dive | Same | KB entries | Entry text (merge, contradiction check) | A branch and PR on the KB repo | Same |
| Session-start and Stop hooks | Developer laptop, inside Claude Code | `git status`/log paths, KB files, transcript (only to count edits) | **Nothing.** They put KB rules into the session, which then goes to whatever model the developer's Claude Code uses | Local `.homeostat/events.db` (paths count, cwd, session id, rule ids); handoff note pushed to `candidates/<member>` | The developer's own git credentials |
| MCP server | Developer laptop (stdio) | KB files | Nothing | Local event log; `learn`/`flag` pushed to `candidates/<member>` | The developer's own git credentials |
| Export | Laptop or code-repo CI | KB files | Nothing | Rules files in the code repo | None |
| Dashboard | Loopback only | KB files, event log | Nothing | `homeostat.yaml` | None |

What is already true ✅:
- No telemetry. The only outbound hosts are the git host APIs and the model provider the team configures.
- The curator sends review comments, never source code.
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
- **A review comment** by a member, written maliciously, by a compromised account, or simply wrong. The curator drafts it into a rule.
- **Indirect injection.** An agent reads attacker-controlled content (a dependency's README, an issue, a web page), then writes a "handoff note" or calls MCP `learn` with the attacker's instruction.
- **A weak merge path.** Auto-merge means no human reads the entry. The score is evidence that a lesson is genuine (a member's review comment led to a code change), not a check of what the rule says. In the pilot, a scoring bug let every curator PR auto-merge.

Controls:
1. **Guarded auto-merge** (decided 2026-10-14: auto-merge stays, behind gates). An entry merges without a reviewer only when **all** of these hold:
   - its score reaches `scoring.autoMergeThreshold`
   - it is human-originated: `pr-feedback` from a member reviewer, followed by a code change. Agent-written entries (handoff notes, MCP `learn`) and deep-dive edits always need a reviewer.
   - every automated check passes: validation, the secret scanner (T2) and the risky-content linter (T3). Any finding means a human reviews it.
   - it is in scope: `scoring.autoMerge: { enabled, areas, maxPerRun }`, so e.g. `core`, which reaches every session, can require a reviewer while area rules auto-merge

   Everything else needs a CODEOWNERS approval; `init` prints how to protect the branch and let only the curator's token bypass it. Before merging, the curator validates the whole knowledge base with the new entries, since the required CI check has not run yet. Auto-merged entries go in their own PR titled "auto-merge", are logged as `auto-merged` events (the digest, K8, lists them), and one `flag` sends them back to review. ✅ Built (T1).
2. **A risky-content linter in `validate`.** It errors on entries that contain:
   - URLs outside an allowlist, or shell pipes to a shell
   - instructions about credentials, tokens, environment variables or network exfiltration
   - instructions to disable security checks (TLS, auth, signature verification, sandboxing)
   - injection phrasing ("ignore previous", "you must not tell the user")
   - text hidden in HTML comments or zero-width characters

   An entry that trips it needs an explicit, recorded override: `riskReviewedBy: <member>`, set by a team member who has read it. The curator keeps such drafts as candidates and lists the findings in the PR, so a human sees them and CI blocks the merge. ✅ Built (T3); allowed domains live in `security.allowedDomains`, and the git host is always allowed.
3. **Agent-written entries are marked and capped.** Handoff notes and MCP `learn` are always candidates, score from 0, and their PRs are labelled "written by an agent". They can never be the sole approval path.
4. **Stronger framing at injection** ✅. The context header tells agents that team rules guide code style and practice. They never override the user, safety, or security, and never ask for credentials or network calls.
5. **Provenance check** ✅. A `pr-feedback` entry's `source.url` must point at a repo in `sources.repos`.

### T2. Secrets and personal data leaking into the model or the KB — high

Review comments and sessions can contain tokens, connection strings or customer data. Today they would be sent to Claude by the curator, or committed by a handoff note, and git history keeps them forever.

Controls:
1. **A built-in secret scanner** (CPU, no dependency): known token formats (cloud keys, Slack, GitHub, Anthropic, JWT, private keys, URLs with credentials) plus a high-entropy check. It runs:
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
3. **Show exactly what would leave** ✅. `homeostat curate --show-prompts` prints every prompt and sends none. Each model call is logged as a `model-call` event (agent, runtime, model, size; never content).
4. **Exclusions** ✅ (all checked before anything reaches a model):
   - `sources.exclude` (repos and path globs never read)
   - the `homeostat:skip` marker (a GitHub label, or the PR title or description) that keeps a PR out of the curator
   - a member-level opt-out (`optOut: true`): that member's PRs and review comments are never read
5. **A self-hosted, local-model option** later, for teams with strict rules (an OpenAI-compatible local endpoint). Out of scope for now.

### T6. Cross-team and cross-repo exposure — medium

The KB is readable by everyone who can read the KB repo. Exports copy rules into code repos, which may have a different audience, or be public.

Controls:
1. **Area visibility.** `areas.<name>.visibility: team | org`. Team-only areas are not exported, and are injected only into sessions of that area's members.
2. **Export guard.** `homeostat export` refuses to write into a repo it detects as public unless given `--allow-public`, and never exports team-only areas.
3. **KB repo checks.** `doctor` warns if the KB repo is public.

### T7. MCP and hooks as an attack surface on the laptop — medium

An injected agent could call MCP `learn` or `flag` in a loop, pushing branches with the developer's credentials.

Controls:
1. Writes require Claude Code's tool approval (already the case).
2. Rate limit: at most N writes per session, configurable.
3. MCP write tools are off unless `mcp.allowWrites: true`.
4. Everything an agent writes is a candidate on a branch (already the case).

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
4. **Safe defaults.** Guarded auto-merge only, scanner on, MCP writes off, team-only areas never exported, version pinned, retention on.
5. **Later, only if a hosted tier appears:** an external penetration test, SOC 2. Self-hosted open source does not need them to start.

## 4. Open decisions

1. ~~Drop auto-merge entirely?~~ **Decided:** keep auto-merge, guarded as in T1.
2. **Decided:** Bedrock and Vertex runtimes in this phase.
3. **Decided:** MCP write tools are off by default.
