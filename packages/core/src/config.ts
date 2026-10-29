import { parseDocument } from "yaml";
import { z } from "zod";
import { CORE_AREA } from "./check.ts";
import { error, type Issue } from "./issues.ts";
import { isKnownArea, RESERVED_REPO_NAMES } from "./layout.ts";
import { ID_PATTERN } from "./schema.ts";
import { fromZod } from "./zod-issues.ts";

export const CONFIG_FILE = "homeostat.yaml";

export const ROLES = ["junior", "member", "senior", "lead"] as const;
export type Role = (typeof ROLES)[number];
/** Seniors and leads: they own the config and unclaimed areas, and add the senior-author bonus. */
export const isSenior = (role: Role) => role === "senior" || role === "lead";

/** Point values for each scoring signal; see `score()`. */
export const DEFAULT_WEIGHTS = {
  /** pr-feedback where the PR's code changed after the comment: the accepted-feedback signal. */
  prFeedbackChangedCode: 3,
  /** pr-feedback with no follow-up code change. */
  prFeedback: 0,
  manual: 2,
  agentHandoff: 0,
  deepDive: 0,
  seniorAuthor: 1,
  conflict: -2,
  /** Per open flag ("this is wrong") on the entry. */
  flag: -2,
} as const;

export type Weights = { -readonly [K in keyof typeof DEFAULT_WEIGHTS]: number };

const name = z.string().regex(ID_PATTERN, "must be lowercase letters, digits and single hyphens");
const cron = z.string().regex(/^\S+(\s+\S+){4}$/, "must be a five-field cron expression");

const weightsSchema = z.strictObject(
  Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, z.int().default(v)])) as {
    [K in keyof Weights]: z.ZodDefault<z.ZodInt>;
  },
);

/** The Claude model the agents draft with; any model id the Messages API accepts. */
export const DEFAULT_AGENT_MODEL = "claude-opus-5-5";

/**
 * The model that judges the daily run's drafts. A model grading its own output agrees with
 * itself, so the default is a different model from the drafter's, and never a dearer one: the
 * current Sonnet under an Opus drafter, Haiku under a Sonnet one (see `judgeModelFor`). The judge
 * checks a short rule against its thread, a narrow task a smaller model does well, and it runs up
 * to `judgeCalls` times a day.
 */
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";
export const SMALL_JUDGE_MODEL = "claude-haiku-4-5-20251001";

/** The judge's model: `agents.curator.judgeModel`, else a default that differs from the drafter's. */
export function judgeModelFor(config: Config): string {
  const { judgeModel, model } = config.agents.curator;
  if (judgeModel) return judgeModel;
  return /sonnet|haiku/.test(model) ? SMALL_JUDGE_MODEL : DEFAULT_JUDGE_MODEL;
}

const agentSchema = (schedule: string, lookbackHours: number) =>
  z.strictObject({
    enabled: z.boolean().default(true),
    schedule: cron.default(schedule),
    model: z.string().min(1).default(DEFAULT_AGENT_MODEL),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    /** How far back each run looks; a little over the schedule so runs overlap. */
    lookbackHours: z.int().positive().default(lookbackHours),
  });

/** `owner/name`: a Bitbucket workspace/repo or a GitHub owner/repo. */
const repoRef = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name");

export const EXPORT_TARGETS = ["claude", "cursor", "agents-md", "copilot"] as const;

export const configSchema = z.strictObject({
  version: z.literal(1),
  team: z.strictObject({
    members: z
      .array(
        z.strictObject({
          id: name,
          /**
           * junior, member, senior or lead (team manager). Seniors and leads own the config and
           * unclaimed areas; the role also weighs a member's lessons in the daily decision.
           */
          role: z.enum(ROLES),
          /** The curator never reads this member's pull requests or review comments. */
          optOut: z.boolean().optional(),
          /**
           * Share per-day usage counts (sessions, injections, rules served, MCP calls, document
           * reads for the last seven days) in the heartbeat, for the team's Performance page.
           * Off by default; HOMEOSTAT_SHARE_USAGE=1 on the member's machine does the same.
           */
          usage: z.boolean().optional(),
          areas: z.array(z.string()).default([]),
          /**
           * The member's git-host identity: `@login`, `@org/team` or an email. On Bitbucket it is
           * the nickname, which may hold spaces and accents (`@Javier Gallostra Acín`).
           */
          handle: z
            .string()
            .regex(
              /^(@[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*(\/[\w.-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/u,
              "handle must be @user, @org/team or an email",
            )
            .optional(),
          /** Slack member ID (profile > ⋯ > Copy member ID): the morning notice mentions reviewers. */
          slack: z
            .string()
            .regex(/^[UW][A-Z0-9]{6,}$/, "slack must be a Slack member ID, like U0123ABCD")
            .optional(),
        }),
      )
      .min(1),
    /**
     * Who decides the lessons the daily run is unsure about. When set, only these members are
     * asked to review its PRs and listed in CODEOWNERS; everyone else's role only weighs their
     * lessons. Unset, area owners decide, then seniors and leads.
     */
    reviewers: z.array(name).optional(),
  }),
  /**
   * Teams: who owns which areas (and so approves changes to them and their documents) and which
   * repos they work in. Reads stay org-wide: every session sees every rule whose scope matches,
   * whichever team wrote it. That is the cross-team memory.
   */
  teams: z
    .record(
      name,
      z.strictObject({
        /** A CODEOWNERS team handle (`@org/team`); otherwise the members' own handles are used. */
        handle: z
          .string()
          .regex(/^@[\w.-]+\/[\w.-]+$/, "handle must be @org/team")
          .optional(),
        members: z.array(z.string()).default([]),
        areas: z.array(z.string()).default([]),
        repos: z.array(repoRef).default([]),
      }),
    )
    .default({}),
  /** Area name → path globs. `core` is implicit and global. A multi-repo KB uses repos.*.areas. */
  areas: z.record(name, z.array(z.string().min(1)).min(1)).default({}),
  /**
   * The team's code repos, by short name (the folder under knowledge/). With this key the KB is
   * multi-repo: knowledge/core/ is shared, knowledge/<repo>/<area>/ is one repo's, and a session
   * only gets its own repo's rules. Without it, every rule applies to every repo.
   */
  /**
   * Topic name → one-line description. With topics, rules are grouped into one file per topic,
   * `knowledge/<area>/<topic>.md`; in a multi-repo KB these are the shared rules' topics, and
   * each repo lists its own under repos.<name>.topics. `general` is always allowed.
   */
  topics: z.record(name, z.string().min(1)).optional(),
  /**
   * Written by homeostat migrate: each old area → the repo it moved to, or "shared" for
   * knowledge/core/. A developer's sync uses it to move their pending lessons.
   */
  migrated: z
    .strictObject({
      /** The day of the migration: pending lessons created by then still have old paths. */
      on: z.iso.date(),
      /** Each old area → the repo it moved to, or "shared". */
      areas: z.record(z.string(), z.string()),
    })
    .optional(),
  repos: z
    .record(
      name,
      z.strictObject({
        /** The repo on the git host, owner/name: the daily run reads its merged PRs. */
        source: repoRef,
        /** Area name → path globs relative to this repo's root. */
        areas: z.record(name, z.array(z.string().min(1)).min(1)).default({}),
        /** Topic name → one-line description: this repo's rules are grouped in topic files. */
        topics: z.record(name, z.string().min(1)).optional(),
      }),
    )
    .optional(),
  scoring: z
    .strictObject({
      weights: weightsSchema.prefault({}),
      autoMergeThreshold: z.int().default(3),
      /**
       * Which curator entries may merge with no reviewer. Every gate in `autoMergeDecision` must
       * pass: threshold, member review feedback with a code change, no risky-content findings or
       * flags, and in scope here. Everything else waits for a CODEOWNERS approval.
       */
      autoMerge: z
        .strictObject({
          enabled: z.boolean().default(true),
          /** Areas that may auto-merge; empty means all, minus `excludeAreas`. */
          areas: z.array(z.string()).default([]),
          /** Areas that always need a reviewer, e.g. `core`, which reaches every session. */
          excludeAreas: z.array(z.string()).default([]),
          maxPerRun: z.int().positive().default(5),
        })
        .prefault({}),
      reviewCadence: z.enum(["daily", "weekly", "biweekly"]).default("weekly"),
      /**
       * The daily run's 0–100 confidence per lesson: merged at or above `accept` (`coreAccept` for
       * rules that reach every session), declined below `decline`, a reviewer in between.
       */
      confidence: z
        .strictObject({
          accept: z.int().min(0).max(100).default(70),
          coreAccept: z.int().min(0).max(100).default(80),
          decline: z.int().min(0).max(100).default(35),
          base: z
            .strictObject({
              prFeedbackChangedCode: z.int().default(50),
              prFeedback: z.int().default(20),
              manual: z.int().default(45),
              agentHandoff: z.int().default(25),
              deepDive: z.int().default(40),
            })
            .prefault({}),
          roles: z
            .strictObject({
              junior: z.int().default(0),
              member: z.int().default(6),
              senior: z.int().default(14),
              lead: z.int().default(20),
            })
            .prefault({}),
          bonus: z
            .strictObject({
              areaOwner: z.int().default(6),
              specific: z.int().default(8),
              goodTitle: z.int().default(4),
              repeat: z.int().default(10),
              modelRating: z.int().default(10),
            })
            .prefault({}),
          penalty: z
            .strictObject({
              vagueTitle: z.int().default(15),
              conflict: z.int().default(25),
              flag: z.int().default(20),
              /** Subtracted when the judge finds a drafted rule says what its thread did not. */
              judge: z.int().default(30),
            })
            .prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
  agents: z
    .strictObject({
      /**
       * How the agents reach Claude. `api` (default) calls the Messages API with a Claude Console
       * key in ANTHROPIC_API_KEY: the right choice for a team. `claude-code` runs `claude -p` with
       * whatever Claude Code is logged in with; on a personal Free/Pro/Max subscription that is
       * for personal, non-commercial use only, so teams use it only with a Team/Enterprise plan.
       * `bedrock` and `vertex` call Claude through the team's own AWS or Google Cloud account.
       */
      runtime: z.enum(["api", "claude-code", "bedrock", "vertex"]).default("api"),
      /** With runtime bedrock: the AWS region (else AWS_REGION). Credentials come from the AWS chain. */
      bedrock: z.strictObject({ region: z.string().min(1).optional() }).optional(),
      /** With runtime vertex: the Google Cloud project and region (`global`, `us`, `eu` or a region). */
      vertex: z
        .strictObject({
          projectId: z.string().min(1).optional(),
          region: z.string().min(1).default("global"),
        })
        .optional(),
      /**
       * Most dollars one daily run, deep dive or bootstrap may spend on model calls; no cap when
       * unset. No call starts once the run has spent it, and what is left waits for the next run.
       * Runtimes that report no cost are priced from their tokens (an estimate, see pricing.ts).
       */
      maxCostUsd: z.number().positive().optional(),
      curator: agentSchema("0 6 * * *", 26)
        .extend({
          /**
           * Most model calls per daily run that decide whether a new lesson updates or repeats a
           * rule already in force. Past it, lessons fall back to the word-overlap duplicate check.
           */
          consolidateCalls: z.int().min(0).default(30),
          /**
           * Most model calls per daily run that judge a confident drafted rule against its review
           * thread before it merges with no person; 0 turns the judge off. Past the cap, drafts
           * that would merge go to a reviewer instead.
           */
          judgeCalls: z.int().min(0).default(100),
          /** The judge's model; by default a different one from `model` (see `judgeModelFor`). */
          judgeModel: z.string().min(1).optional(),
          judgeEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
          /**
           * Most model calls per daily run that rewrite a document section citing a rule the run
           * retires; 0 turns them off (the sections are listed instead).
           */
          retractCalls: z.int().min(0).default(10),
        })
        .prefault({}),
      deepDive: agentSchema("0 7 * * 1", 7 * 24)
        .extend({
          /** Accepted entries not confirmed for this long are retired. */
          staleAfterDays: z.int().positive().default(180),
          /**
           * Most model calls per deep dive that rewrite a document section citing a rule it
           * retires as stale; 0 turns them off (the sections are listed instead).
           */
          retractCalls: z.int().min(0).default(10),
        })
        .prefault({}),
      /** Session handoff notes, asked for by the plugin's Stop hook. Runs in sessions, not on a schedule. */
      handoff: z
        .strictObject({
          /**
           * Off by default: Claude Code shows the question as a "Stop hook error", it adds a turn,
           * and it cannot tell a finished session from one waiting on background work.
           */
          enabled: z.boolean().default(false),
          /** File edits in a session before the agent is asked for a note. */
          minEdits: z.int().positive().default(5),
        })
        .prefault({}),
    })
    .prefault({}),
  distribution: z
    .strictObject({
      exports: z.array(z.enum(EXPORT_TARGETS)).default([...EXPORT_TARGETS]),
      tokenBudget: z.int().positive().default(2000),
      /** Tokens for the document sections that name touched files, on top of the rules. */
      docTokenBudget: z.int().nonnegative().default(1000),
    })
    .prefault({}),
  notifications: z
    .strictObject({
      /** Name of the environment variable holding the webhook URL; never the URL itself. */
      slackWebhookEnv: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable name")
        .optional(),
      digestDay: z
        .enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])
        .default("monday"),
    })
    .prefault({}),
  security: z
    .strictObject({
      /**
       * Domains entries may link to (subdomains included). The git host is always allowed;
       * any other URL in a rule fails validation until a member signs the entry off.
       */
      allowedDomains: z
        .array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "must be a domain"))
        .default([]),
      /** Days the local event log keeps events; older ones are deleted. */
      eventRetentionDays: z.int().positive().default(90),
      /** Areas whose rules are never exported and reach only their own members' sessions. */
      teamOnlyAreas: z.array(z.string()).default([]),
      /** Let agents save and flag entries through MCP. Off by default; the CLI and skills still can. */
      mcpWrites: z.boolean().default(false),
      /** With mcpWrites on: the most learn and flag calls one MCP session may make. */
      mcpWriteLimit: z.int().positive().default(5),
    })
    .prefault({}),
  /** Where the agents read from and write to. Needed by `homeostat curate`, not by validation. */
  sources: z
    .strictObject({
      host: z.enum(["bitbucket", "github"]),
      /** The KB repo itself: the only repo the agents write to, by branch and PR. */
      kbRepo: repoRef,
      baseBranch: z.string().min(1).default("main"),
      /** Code repos whose merged PRs the curator reads. */
      repos: z.array(repoRef).default([]),
      /** Never read: whole repos, and review comments on files matching these globs. */
      exclude: z
        .strictObject({
          repos: z.array(repoRef).default([]),
          paths: z.array(z.string().min(1)).default([]),
        })
        .prefault({}),
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

const RENAMED_KEYS = { verticals: "areas", slackWebhook: "slackWebhookEnv" };

/** Parses and checks `homeostat.yaml`. Returns `config` only when there are no errors. */
export function parseConfig(text: string): { config?: Config; issues: Issue[] } {
  const file = CONFIG_FILE;
  const doc = parseDocument(text);
  if (doc.errors.length) {
    return {
      issues: doc.errors.map((e) => error("config.yaml", `invalid YAML: ${e.message}`, { file })),
    };
  }
  const parsed = configSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    return {
      issues: fromZod(parsed.error, { code: "config.schema", file, renamed: RENAMED_KEYS }),
    };
  }

  const config = parsed.data;
  const issues: Issue[] = [];
  if (Object.hasOwn(config.areas, CORE_AREA)) {
    issues.push(
      error("config.area.reserved", `areas.${CORE_AREA}: reserved; core is implicit and global`, {
        path: `areas.${CORE_AREA}`,
        file,
      }),
    );
  }
  issues.push(...repoIssues(config, file));
  const ids = new Set(config.team.members.map((m) => m.id));
  for (const id of config.team.reviewers ?? []) {
    if (!ids.has(id)) {
      issues.push(
        error("config.team.reviewer", `team.reviewers: "${id}" is not in team.members`, {
          path: "team.reviewers",
          file,
        }),
      );
    }
  }
  const seen = new Set<string>();
  config.team.members.forEach((m, i) => {
    if (seen.has(m.id)) {
      issues.push(
        error("config.member.duplicate", `team.members.${i}.id: "${m.id}" is listed twice`, {
          path: `team.members.${i}.id`,
          file,
        }),
      );
    }
    seen.add(m.id);
    for (const area of m.areas) {
      if (!isKnownArea(config, area)) {
        issues.push(
          error("config.member.area", `team.members.${i}.areas: "${area}" is not in areas`, {
            path: `team.members.${i}.areas`,
            file,
          }),
        );
      }
    }
  });
  const areaTeam = new Map<string, string>();
  for (const [team, t] of Object.entries(config.teams)) {
    const at = `teams.${team}`;
    for (const m of t.members) {
      if (!seen.has(m))
        issues.push(
          error("config.team.member", `${at}.members: "${m}" is not in team.members`, {
            path: `${at}.members`,
            file,
          }),
        );
    }
    for (const area of t.areas) {
      if (!isKnownArea(config, area)) {
        issues.push(
          error("config.team.area", `${at}.areas: "${area}" is not in areas`, {
            path: `${at}.areas`,
            file,
          }),
        );
      } else if (areaTeam.has(area)) {
        issues.push(
          error(
            "config.team.area.owned",
            `${at}.areas: "${area}" is already owned by team ${areaTeam.get(area)}; an area has one owning team`,
            {
              path: `${at}.areas`,
              file,
            },
          ),
        );
      } else areaTeam.set(area, team);
    }
    for (const repo of t.repos) {
      if (config.sources && !config.sources.repos.includes(repo)) {
        issues.push(
          error("config.team.repo", `${at}.repos: "${repo}" is not in sources.repos`, {
            path: `${at}.repos`,
            file,
          }),
        );
      }
    }
    if (!t.handle && t.members.length === 0) {
      issues.push(
        error("config.team.empty", `${at}: give the team a handle or members`, { path: at, file }),
      );
    }
  }
  for (const area of config.security.teamOnlyAreas) {
    if (area === CORE_AREA || !isKnownArea(config, area)) {
      issues.push(
        error(
          "config.security.teamOnlyArea",
          `security.teamOnlyAreas: "${area}" is not in areas${area === CORE_AREA ? " (core reaches everyone by definition)" : ""}`,
          { path: "security.teamOnlyAreas", file },
        ),
      );
    }
  }

  // A multi-repo KB lists its code repos once, under repos; the daily run reads sources.repos.
  if (config.repos && config.sources && config.sources.repos.length === 0) {
    config.sources.repos = Object.values(config.repos).map((r) => r.source);
  }
  return issues.some((i) => i.severity === "error") ? { issues } : { config, issues };
}

/** A multi-repo KB's repos: short names, where its areas live, and no second list of sources. */
function repoIssues(config: Config, file: string): Issue[] {
  const issues: Issue[] = [];
  if (!config.repos) return issues;
  for (const [repo, r] of Object.entries(config.repos)) {
    if ((RESERVED_REPO_NAMES as readonly string[]).includes(repo)) {
      issues.push(
        error("config.repos.reserved", `repos.${repo}: reserved; pick another short name`, {
          path: `repos.${repo}`,
          file,
        }),
      );
    }
    if (Object.hasOwn(r.areas, CORE_AREA)) {
      issues.push(
        error(
          "config.area.reserved",
          `repos.${repo}.areas.${CORE_AREA}: reserved; core is implicit`,
          {
            path: `repos.${repo}.areas.${CORE_AREA}`,
            file,
          },
        ),
      );
    }
  }
  if (Object.keys(config.areas).length) {
    issues.push(
      error(
        "config.areas.with-repos",
        "with repos, areas belong to each repo: move them to repos.<name>.areas",
        { path: "areas", file },
      ),
    );
  }
  if (config.sources?.repos.length) {
    issues.push(
      error(
        "config.sources.repos.with-repos",
        "with repos, list each repo once, as repos.<name>.source",
        { path: "sources.repos", file },
      ),
    );
  }
  return issues;
}
