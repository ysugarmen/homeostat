import {
  type Config,
  DEFAULT_AGENT_MODEL,
  DEFAULT_WEIGHTS,
  EXPORT_TARGETS,
  type Issue,
  parseConfig,
} from "@homeostat/core";
import { isMap, parseDocument } from "yaml";

/** One editable config key. `path` is its location in homeostat.yaml. */
export interface Field {
  path: string[];
  label: string;
  kind: "text" | "number" | "select" | "checkbox" | "checks" | "lines";
  options?: readonly string[];
  help?: string;
  /** Empty means "remove the key" rather than an empty value. */
  optional?: boolean;
}

export interface Section {
  id: string;
  title: string;
  intro: string;
  fields?: Field[];
  /** Row editors for the two keyed lists. */
  rows?: "team" | "areas";
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const agentFields = (agent: "curator" | "deepDive", label: string): Field[] => [
  { path: ["agents", agent, "enabled"], label: `${label}: enabled`, kind: "checkbox" },
  {
    path: ["agents", agent, "schedule"],
    label: `${label}: schedule`,
    kind: "text",
    help: "Five-field cron, UTC",
  },
  {
    path: ["agents", agent, "model"],
    label: `${label}: model`,
    kind: "text",
    help: `Claude model id, e.g. ${DEFAULT_AGENT_MODEL}`,
  },
  {
    path: ["agents", agent, "effort"],
    label: `${label}: effort`,
    kind: "select",
    options: EFFORTS,
  },
  {
    path: ["agents", agent, "lookbackHours"],
    label: `${label}: look back (hours)`,
    kind: "number",
  },
];

/** Every section of homeostat.yaml, so every key is editable without touching YAML (4.2). */
export const SECTIONS: Section[] = [
  {
    id: "team",
    title: "Team and members",
    intro:
      "Who contributes and reviews. Seniors own the config and areas nobody claims; handles feed CODEOWNERS.",
    rows: "team",
  },
  {
    id: "areas",
    title: "Areas",
    intro: "Parts of your code repos, as path globs. Core is implicit and applies everywhere.",
    rows: "areas",
  },
  {
    id: "sources",
    title: "Repos and sources",
    intro:
      "Where the curator reads merged pull requests, and the knowledge-base repo it opens PRs on.",
    fields: [
      {
        path: ["sources", "host"],
        label: "Git host",
        kind: "select",
        options: ["", "bitbucket", "github"],
        help: "Empty removes the section",
      },
      {
        path: ["sources", "kbRepo"],
        label: "Knowledge-base repo",
        kind: "text",
        help: "owner/name",
      },
      { path: ["sources", "baseBranch"], label: "Base branch", kind: "text" },
      {
        path: ["sources", "repos"],
        label: "Code repos",
        kind: "lines",
        help: "One owner/name per line",
      },
      {
        path: ["sources", "exclude", "repos"],
        label: "Never read these repos",
        kind: "lines",
        help: "One owner/name per line",
      },
      {
        path: ["sources", "exclude", "paths"],
        label: "Never read comments on these files",
        kind: "lines",
        help: "One glob per line, e.g. **/secrets/**",
      },
    ],
  },
  {
    id: "scoring",
    title: "Scoring rules",
    intro:
      "Points per signal and the threshold at which a curator's entry is accepted without a reviewer.",
    fields: [
      ...Object.keys(DEFAULT_WEIGHTS).map(
        (k): Field => ({ path: ["scoring", "weights", k], label: `Weight: ${k}`, kind: "number" }),
      ),
      { path: ["scoring", "autoMergeThreshold"], label: "Auto-merge threshold", kind: "number" },
      { path: ["scoring", "autoMerge", "enabled"], label: "Auto-merge", kind: "checkbox" },
      {
        path: ["scoring", "autoMerge", "areas"],
        label: "Auto-merge areas",
        kind: "lines",
        help: "One per line; empty means every area",
      },
      {
        path: ["scoring", "autoMerge", "excludeAreas"],
        label: "Areas that always need a reviewer",
        kind: "lines",
        help: "One per line, e.g. core",
      },
      { path: ["scoring", "autoMerge", "maxPerRun"], label: "Auto-merges per run", kind: "number" },
      {
        path: ["scoring", "reviewCadence"],
        label: "Review cadence",
        kind: "select",
        options: ["daily", "weekly", "biweekly"],
      },
    ],
  },
  {
    id: "agents",
    title: "Agent schedules",
    intro: "How the agents reach Claude, when they run, and with which model.",
    fields: [
      {
        path: ["agents", "runtime"],
        label: "Claude runtime",
        kind: "select",
        options: ["api", "claude-code", "bedrock", "vertex"],
        help: "api: Console key. claude-code: a Claude Code login (personal use, or a Team/Enterprise plan). bedrock / vertex: your own AWS or Google Cloud account",
      },
      {
        path: ["agents", "bedrock", "region"],
        label: "Bedrock region",
        kind: "text",
        optional: true,
        help: "e.g. eu-west-1; empty uses AWS_REGION",
      },
      {
        path: ["agents", "vertex", "projectId"],
        label: "Vertex project",
        kind: "text",
        optional: true,
        help: "Google Cloud project id",
      },
      {
        path: ["agents", "vertex", "region"],
        label: "Vertex region",
        kind: "text",
        optional: true,
        help: "global, us, eu or a region",
      },
      ...agentFields("curator", "Curator"),
      ...agentFields("deepDive", "Deep dive"),
      {
        path: ["agents", "deepDive", "staleAfterDays"],
        label: "Deep dive: retire after (days unconfirmed)",
        kind: "number",
      },
      { path: ["agents", "handoff", "enabled"], label: "Handoff notes: enabled", kind: "checkbox" },
      {
        path: ["agents", "handoff", "minEdits"],
        label: "Handoff notes: edits before asking",
        kind: "number",
      },
    ],
  },
  {
    id: "distribution",
    title: "Distribution",
    intro: "Which agents receive the rules as files, and how much context each session gets.",
    fields: [
      {
        path: ["distribution", "exports"],
        label: "Export targets",
        kind: "checks",
        options: EXPORT_TARGETS,
      },
      { path: ["distribution", "tokenBudget"], label: "Token budget per session", kind: "number" },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    intro:
      "The weekly digest. The webhook URL stays in your CI secrets; only its variable name lives here.",
    fields: [
      {
        path: ["notifications", "slackWebhookEnv"],
        label: "Slack webhook variable",
        kind: "text",
        optional: true,
        help: "e.g. HOMEOSTAT_SLACK_WEBHOOK",
      },
      {
        path: ["notifications", "digestDay"],
        label: "Digest day",
        kind: "select",
        options: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
      },
    ],
  },
  {
    id: "security",
    title: "Security",
    intro:
      "Domains rules may link to. Any other URL in a rule fails validation until a member signs the entry off; the git host is always allowed.",
    fields: [
      {
        path: ["security", "allowedDomains"],
        label: "Allowed domains",
        kind: "lines",
        help: "One domain per line, e.g. docs.example.com",
      },
      {
        path: ["security", "teamOnlyAreas"],
        label: "Team-only areas",
        kind: "lines",
        help: "Never exported; only their members' sessions see them",
      },
      {
        path: ["security", "mcpWrites"],
        label: "Let agents save and flag through MCP",
        kind: "checkbox",
      },
      { path: ["security", "mcpWriteLimit"], label: "MCP writes per session", kind: "number" },
      {
        path: ["security", "eventRetentionDays"],
        label: "Keep local events for (days)",
        kind: "number",
      },
    ],
  },
];

/** The current value of a field, from the parsed (defaulted) config. */
export function currentValue(config: Config, field: Field): unknown {
  let v: unknown = config;
  for (const k of field.path) v = (v as Record<string, unknown> | undefined)?.[k];
  return v;
}

const lines = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

export interface ApplyResult {
  text?: string;
  issues: Issue[];
}

/**
 * Applies one submitted section to the YAML text, keeping comments and untouched keys, and
 * validates the result. Returns the new text only when it is valid.
 */
export function applySection(
  yamlText: string,
  sectionId: string,
  form: URLSearchParams,
): ApplyResult {
  const section = SECTIONS.find((s) => s.id === sectionId);
  if (!section)
    return {
      issues: [
        { code: "settings.section", severity: "error", message: `unknown section ${sectionId}` },
      ],
    };
  const doc = parseDocument(yamlText);

  if (section.rows === "team") {
    const members = rowIndices(form, "member").flatMap((i) => {
      const id = form.get(`member.${i}.id`)?.trim();
      if (!id || form.get(`member.${i}.remove`)) return [];
      const handle = form.get(`member.${i}.handle`)?.trim();
      const areas = lines(form.get(`member.${i}.areas`) ?? "");
      return [
        {
          id,
          ...(handle ? { handle } : {}),
          role: form.get(`member.${i}.role`) ?? "member",
          areas,
          ...(form.get(`member.${i}.optOut`) ? { optOut: true } : {}),
        },
      ];
    });
    doc.setIn(["team", "members"], doc.createNode(members));
  } else if (section.rows === "areas") {
    const areas: Record<string, string[]> = {};
    for (const i of rowIndices(form, "area")) {
      const name = form.get(`area.${i}.name`)?.trim();
      if (!name || form.get(`area.${i}.remove`)) continue;
      areas[name] = lines(form.get(`area.${i}.globs`) ?? "");
    }
    doc.setIn(["areas"], doc.createNode(areas));
  } else {
    for (const field of section.fields ?? []) {
      const name = field.path.join(".");
      const raw = form.get(name);
      if (field.path.join(".") === "sources.host" && !raw) {
        doc.deleteIn(["sources"]);
        break;
      }
      if (field.kind === "checkbox") doc.setIn(field.path, form.get(name) === "on");
      else if (field.kind === "checks") doc.setIn(field.path, doc.createNode(form.getAll(name)));
      else if (field.kind === "lines") doc.setIn(field.path, doc.createNode(lines(raw ?? "")));
      else if (field.kind === "number")
        doc.setIn(field.path, raw === null || raw === "" ? undefined : Number(raw));
      else if (field.optional && !raw?.trim()) {
        if (doc.hasIn(field.path)) doc.deleteIn(field.path);
      } else if (raw !== null) doc.setIn(field.path, raw.trim());
    }
  }

  // Drop sections that became empty maps, so the defaults apply.
  for (const key of ["notifications", "distribution", "scoring", "security"]) {
    const node = doc.get(key, true);
    if (isMap(node) && node.items.length === 0) doc.delete(key);
  }

  const text = doc.toString();
  const { config, issues } = parseConfig(text);
  return config ? { text, issues: [] } : { issues };
}

/** Row numbers present in the form for a row editor (`member.0.id`, `member.3.id`, ...). */
function rowIndices(form: URLSearchParams, prefix: string): number[] {
  const seen = new Set<number>();
  for (const key of form.keys()) {
    const m = new RegExp(`^${prefix}\\.(\\d+)\\.`).exec(key);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}
