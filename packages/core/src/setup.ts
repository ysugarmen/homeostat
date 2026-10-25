import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codeownersFile } from "./codeowners.ts";
import { CONFIG_FILE, type Config, parseConfig } from "./config.ts";
import type { KbFiles } from "./validate.ts";

/**
 * The checklist `homeostat setup` walks, in order. Shared by the CLI, which checks every step
 * (some against the git host), and the dashboard, which decides what it can from local files and
 * shows the last recorded result for the rest.
 */
export type SetupStepName =
  | "host"
  | "token"
  | "repos"
  | "areas"
  | "team"
  | "reviewers"
  | "model"
  | "slack"
  | "schedules"
  | "codeowners"
  | "commit"
  | "bootstrap"
  | "teammates";

export interface SetupStepInfo {
  name: SetupStepName;
  title: string;
  required: boolean;
  /** For an optional step: what you lose without it. For a required one: what it is for. */
  why: string;
  /**
   * Whether only a call to the git host, the model or Slack can verify it (a stored secret, a
   * schedule). The dashboard shows those from the last recorded check.
   */
  remote: boolean;
}

export const SETUP_STEPS: readonly SetupStepInfo[] = [
  {
    name: "host",
    title: "KB repo and host",
    required: true,
    why: "Where the knowledge base lives and which git host runs it.",
    remote: false,
  },
  {
    name: "token",
    title: "Git-host token for CI",
    required: true,
    why: "The daily run reads review comments and opens PRs with it.",
    remote: true,
  },
  {
    name: "repos",
    title: "Code repos",
    required: true,
    why: "The repos whose merged PRs the daily run reads; at least one.",
    remote: false,
  },
  {
    name: "areas",
    title: "Areas per repo",
    required: false,
    why: "Without areas every rule applies to the whole repo.",
    remote: false,
  },
  {
    name: "team",
    title: "Team",
    required: true,
    why: "You are required; only members' review comments become lessons.",
    remote: false,
  },
  {
    name: "reviewers",
    title: "Reviewers",
    required: false,
    why: "Without them, area owners, then seniors and leads, review the middle band.",
    remote: false,
  },
  {
    name: "model",
    title: "Model credential",
    required: true,
    why: "Needed for drafting; without it, daily --no-reviews only decides hand-written lessons.",
    remote: true,
  },
  {
    name: "slack",
    title: "Slack",
    required: false,
    why: "Without it, nobody is pinged about the review queue or the weekly digest.",
    remote: true,
  },
  {
    name: "schedules",
    title: "Schedules",
    required: true,
    why: "Nothing runs on its own without them.",
    remote: true,
  },
  {
    name: "codeowners",
    title: "CODEOWNERS and branch protection",
    required: false,
    why: "Recommended: without protection, anyone can merge unreviewed rules.",
    remote: false,
  },
  {
    name: "commit",
    title: "Commit and push",
    required: true,
    why: "CI runs what is pushed, not what is on your laptop.",
    remote: true,
  },
  {
    name: "bootstrap",
    title: "First base",
    required: false,
    why: "Without it the KB starts empty and fills from reviews.",
    remote: false,
  },
  {
    name: "teammates",
    title: "Teammates",
    required: false,
    why: "Teammates' sessions get no rules until they install the plugin.",
    remote: false,
  },
];

export const setupStep = (name: string): SetupStepInfo | undefined =>
  SETUP_STEPS.find((s) => s.name === name);

export type SetupState = "done" | "missing" | "broken" | "optional" | "unknown";

export interface SetupCheck {
  state: SetupState;
  reason?: string;
}

/** The git-ignored record of the last checks, so the dashboard can show them without a network call. */
export const SETUP_RECORD_FILE = ".homeostat/setup.json";

export interface SetupRecordItem {
  state: SetupState;
  checkedAt: string;
  reason?: string;
}

/** Step name (or `join`, this laptop's plugin setup) → its last check. Never holds a secret. */
export type SetupRecord = Record<string, SetupRecordItem>;

export function readSetupRecord(root: string): SetupRecord {
  try {
    const parsed = JSON.parse(readFileSync(join(root, SETUP_RECORD_FILE), "utf8")) as {
      steps?: SetupRecord;
    };
    return parsed.steps && typeof parsed.steps === "object" ? parsed.steps : {};
  } catch {
    return {};
  }
}

/** Merges these results into the record. Reasons are short, written by setup, never a value. */
export function writeSetupRecord(
  root: string,
  results: Record<string, SetupCheck>,
  at: Date = new Date(),
): void {
  const steps = readSetupRecord(root);
  for (const [name, r] of Object.entries(results)) {
    steps[name] = {
      state: r.state,
      checkedAt: at.toISOString(),
      ...(r.reason ? { reason: r.reason.slice(0, 200) } : {}),
    };
  }
  const path = join(root, SETUP_RECORD_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, steps }, null, 2)}\n`);
}

/** The custom pipelines (Bitbucket) or workflows (GitHub) the schedules run. */
export interface WantedSchedule {
  pipeline: string;
  /** Five-field cron, UTC. */
  cron: string;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The daily run, the deep dive when enabled, and the digest when Slack is set. */
export function wantedSchedules(config: Config): WantedSchedule[] {
  const wanted: WantedSchedule[] = [];
  if (config.agents.curator.enabled)
    wanted.push({ pipeline: "homeostat-curator", cron: config.agents.curator.schedule });
  if (config.agents.deepDive.enabled)
    wanted.push({ pipeline: "homeostat-deep-dive", cron: config.agents.deepDive.schedule });
  if (config.notifications.slackWebhookEnv)
    wanted.push({
      pipeline: "homeostat-digest",
      cron: `0 8 * * ${DAYS.indexOf(config.notifications.digestDay)}`,
    });
  return wanted;
}

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/**
 * A five-field cron as Bitbucket's schedules take it: seconds first, a year last, and `?` in one
 * of the two day fields. Day-of-week numbers become names, since Bitbucket counts from 1 = SUN.
 */
export function bitbucketCron(cron: string): string {
  const [min = "0", hour = "0", dom = "*", month = "*", dow = "*"] = cron.trim().split(/\s+/);
  const days = dow.replace(/\d/g, (d) => DOW[Number(d)] ?? d);
  return dow === "*" || dow === "?"
    ? `0 ${min} ${hour} ${dom} ${month} ? *`
    : `0 ${min} ${hour} ? ${month} ${days} *`;
}

/** The CI files that hold the schedules `init` writes, per host. */
export function scheduledCiPresent(root: string, host: "bitbucket" | "github"): boolean {
  if (host === "github")
    return ["homeostat-curator.yml", "homeostat-deep-dive.yml"].every((f) =>
      existsSync(join(root, ".github/workflows", f)),
    );
  const path = join(root, "bitbucket-pipelines.yml");
  return existsSync(path) && readFileSync(path, "utf8").includes("homeostat-curator:");
}

/** Whether the KB holds any document yet (a first base). */
export const hasDocuments = (files: KbFiles): boolean =>
  Object.keys(files).some((p) => /^knowledge\/(.+\/)?docs\/[^/]+\.md$/.test(p));

/**
 * What the local files decide for each step, without a network call; undefined for a step only a
 * remote check (or git) can decide. A remote step whose local part is missing reports that.
 */
export function localSetupChecks(
  root: string,
  files: KbFiles,
): Partial<Record<SetupStepName, SetupCheck>> {
  const text = files[CONFIG_FILE];
  if (text === undefined) return { host: { state: "missing", reason: `no ${CONFIG_FILE} yet` } };
  const { config, issues } = parseConfig(text);
  if (!config) {
    const first = issues.find((i) => i.severity === "error");
    return { host: { state: "broken", reason: first?.message ?? `${CONFIG_FILE} is invalid` } };
  }
  const out: Partial<Record<SetupStepName, SetupCheck>> = {};
  const sources = config.sources;
  out.host = sources
    ? { state: "done", reason: `${sources.host}, ${sources.kbRepo}` }
    : { state: "missing", reason: "no sources section (host and KB repo)" };

  const repos = [
    ...new Set([
      ...(sources?.repos ?? []),
      ...Object.values(config.repos ?? {}).map((r) => r.source),
    ]),
  ];
  out.repos = repos.length
    ? { state: "done", reason: repos.join(", ") }
    : { state: "missing", reason: "no code repos listed" };

  const areaCount =
    Object.keys(config.areas).length +
    Object.values(config.repos ?? {}).reduce((n, r) => n + Object.keys(r.areas).length, 0);
  out.areas = areaCount ? { state: "done", reason: `${areaCount} areas` } : { state: "optional" };

  const noHandle = config.team.members.filter((m) => !m.handle).map((m) => m.id);
  out.team = noHandle.length
    ? { state: "missing", reason: `no handle for ${noHandle.join(", ")}` }
    : { state: "done", reason: `${config.team.members.length} members` };

  out.reviewers = config.team.reviewers?.length
    ? { state: "done", reason: config.team.reviewers.join(", ") }
    : { state: "optional" };

  if (config.agents.runtime === "bedrock" || config.agents.runtime === "vertex")
    out.model = { state: "done", reason: `${config.agents.runtime}: the CI identity's access` };

  if (!config.notifications.slackWebhookEnv) out.slack = { state: "optional" };

  if (sources && !scheduledCiPresent(root, sources.host))
    out.schedules = {
      state: "missing",
      reason:
        sources.host === "github"
          ? "the curator and deep-dive workflows are missing"
          : "bitbucket-pipelines.yml has no homeostat-curator pipeline",
    };

  const owners = codeownersFile(sources?.host);
  out.codeowners = existsSync(join(root, owners))
    ? { state: "done", reason: owners }
    : { state: "optional" };

  out.bootstrap = hasDocuments(files) ? { state: "done" } : { state: "optional" };
  return out;
}

export interface SetupRow extends SetupStepInfo {
  state: SetupState;
  reason?: string;
  /** Where the state comes from: the files here, the last recorded check, or neither yet. */
  source: "local" | "record" | "none";
  checkedAt?: string;
}

/**
 * The checklist as far as the files and the record decide it. A remote step reads its last
 * recorded check; with `shared` (a build anyone can read, where the record is not) it is left out.
 */
export function setupRows(
  root: string,
  files: KbFiles,
  record: SetupRecord,
  opts: { shared?: boolean } = {},
): SetupRow[] {
  const local = localSetupChecks(root, files);
  const rows: SetupRow[] = [];
  for (const step of SETUP_STEPS) {
    const l = local[step.name];
    // A cloud runtime's model step is done locally: nothing remote is stored for it.
    const settled = l && (l.state !== "done" || !step.remote || step.name === "model");
    if (settled || (l && opts.shared)) {
      rows.push({ ...step, ...l, source: "local" });
      continue;
    }
    if (opts.shared) continue;
    const r = record[step.name];
    if (r) {
      rows.push({
        ...step,
        state: r.state,
        ...(r.reason ? { reason: r.reason } : {}),
        source: "record",
        checkedAt: r.checkedAt,
      });
    } else if (step.remote || step.name === "commit") {
      rows.push({ ...step, state: "unknown", source: "none" });
    } else {
      rows.push({ ...step, state: step.required ? "missing" : "optional", source: "none" });
    }
  }
  return rows;
}
