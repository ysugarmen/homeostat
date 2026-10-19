import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bitbucketAuth, type Config, readKbFiles, VERSION, validate } from "@homeostat/core";
import { minimatch } from "minimatch";
import type { Io } from "./cli.ts";
import { painter } from "./format.ts";
import { BITBUCKET_USER_VAR, CliError, TOKEN_VARS } from "./provider.ts";

export type Level = "ok" | "warn" | "fail" | "info";
export interface Check {
  level: Level;
  message: string;
}
export interface Section {
  question: string;
  checks: Check[];
}

const ok = (message: string): Check => ({ level: "ok", message });
const warn = (message: string): Check => ({ level: "warn", message });
const fail = (message: string): Check => ({ level: "fail", message });
const info = (message: string): Check => ({ level: "info", message });

const RUNTIME_PATH: Record<Config["agents"]["runtime"], string> = {
  api: "Anthropic's Claude API (not used for training by default; zero data retention on request)",
  bedrock: "Claude in Amazon Bedrock, inside your AWS account",
  vertex: "Claude on Google Cloud, inside your project",
  "claude-code": "whatever Claude Code is logged in to (a personal plan is non-commercial only)",
};

/** A small client for the few git-host calls the checks need; every failure is "unknown". */
function hostApi(host: "github" | "bitbucket", io: Io) {
  const token = TOKEN_VARS[host].map((v) => io.env?.[v]).find(Boolean);
  const base = host === "github" ? "https://api.github.com/repos" : "https://api.bitbucket.org/2.0";
  const get = async (path: string, auth: boolean) => {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (auth && token) {
        headers.Authorization =
          host === "bitbucket"
            ? bitbucketAuth(token, io.env?.[BITBUCKET_USER_VAR])
            : `Bearer ${token}`;
      }
      const res = await (io.fetch ?? fetch)(`${base}${path}`, { headers });
      const body = res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
      return { status: res.status, body };
    } catch {
      return { status: 0, body: undefined };
    }
  };
  return { token, get };
}

async function hostChecks(config: Config, io: Io): Promise<{ access: Check[]; blast: Check[] }> {
  const sources = config.sources;
  const access: Check[] = [];
  const blast: Check[] = [];
  if (!sources) return { access: [info("no sources section: the curator is not set up")], blast };
  const api = hostApi(sources.host, io);
  const gh = sources.host === "github";
  const repoPath = (r: string) => (gh ? `/${r}` : `/repositories/${r}`);

  const pub = await api.get(repoPath(sources.kbRepo), false);
  if (pub.status === 200)
    blast.push(warn(`the KB repo ${sources.kbRepo} is public: anyone can read your team's rules`));
  else if (pub.status === 0)
    blast.push(
      info(`could not reach ${sources.host} to check whether ${sources.kbRepo} is public`),
    );
  else blast.push(ok(`the KB repo ${sources.kbRepo} is not publicly readable`));

  if (!api.token) {
    const vars = TOKEN_VARS[sources.host].join(" or ");
    access.push(info(`set ${vars} to check branch protection and the token's reach`));
    return { access, blast };
  }

  // Branch protection: without it, anything can merge into what every session reads.
  if (gh) {
    const b = await api.get(`/${sources.kbRepo}/branches/${sources.baseBranch}`, true);
    // `protected` reflects classic branch protection; rulesets show up in the branch's rules.
    const rules =
      b.body?.protected === true
        ? undefined
        : await api.get(`/${sources.kbRepo}/rules/branches/${sources.baseBranch}`, true);
    const ruleTypes = Array.isArray(rules?.body)
      ? (rules.body as { type?: string }[]).map((r) => r.type)
      : [];
    const guarded = ruleTypes.some((t) => t === "pull_request" || t === "required_status_checks");
    if (b.body?.protected === true)
      access.push(ok(`${sources.baseBranch} is protected on ${sources.kbRepo}`));
    else if (guarded)
      access.push(ok(`${sources.baseBranch} is protected by a ruleset on ${sources.kbRepo}`));
    // GitHub answers 403 here when the plan cannot protect a private repository's branches.
    else if (rules?.status === 403)
      access.push(
        fail(
          `${sources.baseBranch} cannot be protected on ${sources.kbRepo}: GitHub protects branches of private repositories only on paid plans (Pro, Team). Without it anything can merge unreviewed; keep the KB's writers few`,
        ),
      );
    else if (b.body)
      access.push(
        fail(
          `${sources.baseBranch} is not protected on ${sources.kbRepo}: anything can merge unreviewed (see homeostat init's guidance)`,
        ),
      );
    else access.push(info(`could not read branch protection on ${sources.kbRepo} (${b.status})`));
  } else {
    const r = await api.get(
      `/repositories/${sources.kbRepo}/branch-restrictions?pagelen=100`,
      true,
    );
    const values = r.body?.values as BbRestriction[] | undefined;
    const base = sources.baseBranch;
    // A branching-model restriction (production, development) can't be resolved here; count it.
    const kinds = new Set(
      values
        ?.filter((v) => v.branch_match_kind === "branching_model" || minimatch(base, v.pattern))
        .map((v) => v.kind),
    );
    if (!values)
      access.push(
        info(`could not read branch restrictions on ${sources.kbRepo} (${r.status}; needs admin)`),
      );
    else if (
      !kinds.has("require_approvals_to_merge") &&
      !kinds.has("require_default_reviewer_approvals_to_merge")
    )
      access.push(
        fail(
          `merges into ${base} on ${sources.kbRepo} need no approval: anything can merge unreviewed`,
        ),
      );
    else if (!kinds.has("enforce_merge_checks"))
      access.push(
        fail(
          `merges into ${base} on ${sources.kbRepo} ask for an approval but anyone can merge past it: only Bitbucket Premium enforces merge checks ("Prevent a merge with unresolved merge checks"). Without it keep the KB's writers few`,
        ),
      );
    else access.push(ok(`merges into ${base} on ${sources.kbRepo} need an approval`));
  }

  // The token: code repos need read only; only the KB repo needs write.
  for (const repo of sources.repos) {
    let canWrite: boolean | undefined;
    if (gh) {
      const r = await api.get(`/${repo}`, true);
      const perms = r.body?.permissions as { push?: boolean } | undefined;
      canWrite = perms ? perms.push === true : undefined;
    } else {
      const q = encodeURIComponent(`repository.full_name="${repo}"`);
      const r = await api.get(`/user/permissions/repositories?q=${q}`, true);
      const perm = (r.body?.values as { permission: string }[] | undefined)?.[0]?.permission;
      canWrite = perm ? perm !== "read" : undefined;
    }
    if (canWrite === true)
      blast.push(fail(`the token can write ${repo}; code repos need read access only`));
    else if (canWrite === false) blast.push(ok(`the token reads ${repo} without write access`));
    else blast.push(info(`could not check the token's access to ${repo}`));
  }
  return { access, blast };
}

interface BbRestriction {
  kind: string;
  branch_match_kind?: "branching_model" | "glob";
  pattern: string;
}

/** Bitbucket Cloud reads only `.bitbucket/CODEOWNERS`; GitHub also reads the root and `.github/`. */
function codeownersCheck(root: string, config: Config): Check {
  const routes = ok("CODEOWNERS routes each area to its reviewers");
  if (config.sources?.host === "bitbucket") {
    if (existsSync(join(root, ".bitbucket/CODEOWNERS"))) return routes;
    return existsSync(join(root, "CODEOWNERS"))
      ? warn("Bitbucket reads CODEOWNERS only from .bitbucket/: rerun homeostat codeowners")
      : warn("no CODEOWNERS file: run homeostat codeowners");
  }
  return existsSync(join(root, ".github/CODEOWNERS")) || existsSync(join(root, "CODEOWNERS"))
    ? routes
    : warn("no CODEOWNERS file: run homeostat codeowners");
}

/** CI files that run homeostat, and any floating version they use. */
function pinnedVersions(root: string): Check[] {
  const ci = [
    ...(existsSync(join(root, ".github/workflows"))
      ? readdirSync(join(root, ".github/workflows")).map((f) => `.github/workflows/${f}`)
      : []),
    ...(existsSync(join(root, "bitbucket-pipelines.yml")) ? ["bitbucket-pipelines.yml"] : []),
  ];
  const checks: Check[] = [];
  for (const path of ci) {
    const text = readFileSync(join(root, path), "utf8");
    // Only command lines (npx, dlx, a run: step or a script list item): a job's `name:` or a
    // `git config user.name "homeostat deep-dive"` line reads the same but runs nothing.
    for (const m of text.matchAll(
      /(?:\bnpx(?:\s+(?:--yes|-y))?|\bdlx|\brun:|^\s*-)\s+homeostat(@[^\s"']*)?\s+(validate|daily|curate|deep-dive|digest|export)\b/gm,
    )) {
      const version = m[1]?.slice(1);
      if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
        checks.push(
          fail(
            `${path} runs homeostat${m[1] ?? ""}: pin an exact version (homeostat@${VERSION}) so a new release cannot run unreviewed`,
          ),
        );
      }
    }
  }
  if (checks.length === 0 && ci.length) checks.push(ok("CI pins an exact homeostat version"));
  return checks;
}

/** The security review: one section per question in docs/security.md. */
export async function securityReport(root: string, config: Config, io: Io): Promise<Section[]> {
  const s = config.security;
  const sources = config.sources;
  const { access, blast } = await hostChecks(config, io);

  const reads: Check[] = [
    info(
      `code repos read: ${sources?.repos.join(", ") || "none"} (merged PRs and review comments, never source code)`,
    ),
    info("source code reaches a model only when someone runs homeostat seed by hand"),
    sources?.exclude.repos.length || sources?.exclude.paths.length
      ? ok(
          `excluded: ${[...(sources?.exclude.repos ?? []), ...(sources?.exclude.paths ?? [])].join(", ")}`,
        )
      : info("nothing excluded (sources.exclude); PRs marked homeostat:skip are always skipped"),
  ];
  const optedOut = config.team.members.filter((m) => m.optOut).map((m) => m.id);
  if (optedOut.length) reads.push(ok(`opted out: ${optedOut.join(", ")}`));

  const leaves: Check[] = [
    info(`model calls go to ${RUNTIME_PATH[config.agents.runtime]}`),
    info("review threads are scanned for secrets and redacted before any model call"),
    info("homeostat curate --show-prompts prints every prompt and sends none"),
    ok("no telemetry: the only outbound calls are to your git host and the model runtime above"),
  ];
  if (config.agents.runtime === "claude-code") {
    leaves.push(warn("agents.runtime: claude-code is for personal use or a Team/Enterprise plan"));
  }

  const am = config.scoring.autoMerge;
  const changes: Check[] = [
    ...access,
    am.enabled
      ? info(
          `the daily run merges lessons at confidence ${config.scoring.confidence.accept}+ (${config.scoring.confidence.coreAccept}+ for core), declines below ${config.scoring.confidence.decline}, and asks a reviewer in between; risky content, conflicts and document edits always go to a reviewer; ${am.areas.length ? `areas ${am.areas.join(", ")}` : "all areas"}${am.excludeAreas.length ? ` except ${am.excludeAreas.join(", ")}` : ""}`,
        )
      : ok("auto-merge is off: the daily run sends every lesson to a reviewer"),
    codeownersCheck(root, config),
    s.mcpWrites
      ? warn(`agents can save and flag through MCP (at most ${s.mcpWriteLimit} per session)`)
      : ok("agents cannot write through MCP (security.mcpWrites is off)"),
    ok("risky-content and secret checks run in validate on every entry"),
  ];

  const compromised: Check[] = [
    ...blast,
    ...pinnedVersions(root),
    ok(
      `local event logs are pruned after ${s.eventRetentionDays} days and never leave the machine`,
    ),
    s.teamOnlyAreas.length
      ? ok(`team-only areas, never exported: ${s.teamOnlyAreas.join(", ")}`)
      : info("no team-only areas (security.teamOnlyAreas)"),
  ];

  return [
    { question: "What does it read?", checks: reads },
    { question: "What leaves your network?", checks: leaves },
    { question: "Who can change what agents are told?", checks: changes },
    { question: "What if something is compromised?", checks: compromised },
  ];
}

/** `homeostat doctor --security`: the review a security team can run itself. */
export async function runDoctor(opts: { dir?: string }, io: Io): Promise<number> {
  const root = resolve(opts.dir ?? io.env?.HOMEOSTAT_DIR ?? ".");
  const { config } = validate(readKbFiles(root));
  if (!config) {
    io.stderr(
      `${new CliError("homeostat.yaml is missing or invalid; run homeostat validate").message}\n`,
    );
    return 1;
  }
  const paint = painter(io);
  const mark = {
    ok: paint("green", "✓"),
    warn: paint("yellow", "!"),
    fail: paint("red", "✗"),
    info: "·",
  };
  const sections = await securityReport(root, config, io);
  for (const section of sections) {
    io.stdout(`\n${section.question}\n`);
    for (const c of section.checks) io.stdout(`  ${mark[c.level]} ${c.message}\n`);
  }
  const all = sections.flatMap((s) => s.checks);
  const failed = all.filter((c) => c.level === "fail").length;
  const warned = all.filter((c) => c.level === "warn").length;
  io.stdout(`\n${failed} to fix, ${warned} to review\n`);
  return failed ? 1 : 0;
}
