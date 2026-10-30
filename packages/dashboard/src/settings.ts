import {
  type Config,
  DEFAULT_AGENT_MODEL,
  DEFAULT_JUDGE_MODEL,
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
  /** `pairs`: one `name: text` per line, a name → text map such as topics. */
  kind: "text" | "number" | "select" | "checkbox" | "checks" | "lines" | "pairs";
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
  rows?: "team" | "areas" | "teams" | "repos";
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
    id: "reviewers",
    title: "Reviewers",
    intro:
      "Who decides the lessons the daily run is unsure about. Leave empty to ask area owners, then seniors and leads.",
    fields: [
      {
        path: ["team", "reviewers"],
        label: "Reviewers",
        kind: "lines",
        help: "One member id per line; only they are asked to review",
        optional: true,
      },
    ],
  },
  {
    id: "repos",
    title: "Repos",
    intro:
      "A multi-repo knowledge base: each code repo by short name, its folder under knowledge/. Shared rules live in knowledge/core/, each repo's in knowledge/<repo>/<area>/, and a session gets only its own repo's rules. Leave empty for one repo.",
    rows: "repos",
  },
  {
    id: "topics",
    title: "Topics",
    intro:
      "Group rules into one file per topic. These are the shared rules' topics (or every rule's, with one repo); each repo lists its own in Repos. general is always there.",
    fields: [
      {
        path: ["topics"],
        label: "Topics",
        kind: "pairs",
        help: "One per line: name: what belongs there, e.g. migrations: Alembic changes and backfills",
        optional: true,
      },
    ],
  },
  {
    id: "areas",
    title: "Areas",
    intro: "Parts of your code repos, as path globs. Core is implicit and applies everywhere.",
    rows: "areas",
  },
  {
    id: "teams",
    title: "Teams",
    intro:
      "Which team owns which areas: it approves their rules and documents. Every session still reads every team's rules for the files it touches.",
    rows: "teams",
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
      {
        path: ["scoring", "autoMergeThreshold"],
        label:
          "Score threshold for homeostat curate on its own (legacy; the daily run uses confidence)",
        kind: "number",
      },
      { path: ["scoring", "confidence", "accept"], label: "Merge at confidence", kind: "number" },
      {
        path: ["scoring", "confidence", "coreAccept"],
        label: "Merge at confidence (core or global rules)",
        kind: "number",
      },
      {
        path: ["scoring", "confidence", "decline"],
        label: "Decline below confidence",
        kind: "number",
      },
      ...(
        [
          ["base", ["prFeedbackChangedCode", "prFeedback", "manual", "agentHandoff", "deepDive"]],
          ["roles", ["junior", "member", "senior", "lead"]],
          ["bonus", ["areaOwner", "specific", "goodTitle", "repeat", "modelRating"]],
          ["penalty", ["vagueTitle", "conflict", "flag", "judge"]],
        ] as const
      ).flatMap(([group, keys]) =>
        keys.map(
          (k): Field => ({
            path: ["scoring", "confidence", group, k],
            label: `Confidence ${group}: ${k}`,
            kind: "number",
          }),
        ),
      ),
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
      {
        path: ["agents", "maxCostUsd"],
        label: "Spending cap per run (USD)",
        kind: "number",
        optional: true,
        help: "Daily run, deep dive and bootstrap stop making model calls once a run has spent this; what is left waits for the next run. Empty: no cap",
      },
      ...agentFields("curator", "Daily run (curator)"),
      {
        path: ["agents", "curator", "consolidateCalls"],
        label: "Daily run: update-or-add checks per run",
        kind: "number",
        help: "Model calls that decide whether a lesson updates an existing rule; 0 turns them off",
      },
      {
        path: ["agents", "curator", "docPatchCalls"],
        label: "Daily run: document checks per run",
        kind: "number",
        help: "Threads checked for making a team document out of date; each sends only the three best-matching sections. 0 turns them off",
      },
      {
        path: ["agents", "curator", "judgeCalls"],
        label: "Daily run: judge calls per run",
        kind: "number",
        help: "A second model checks drafts about to merge with no person against their review thread; 0 turns it off, past the cap they go to a reviewer",
      },
      {
        path: ["agents", "curator", "judgeModel"],
        label: "Daily run: judge model",
        kind: "text",
        optional: true,
        help: `Empty: ${DEFAULT_JUDGE_MODEL}, or ${DEFAULT_AGENT_MODEL} when the drafter already runs on it`,
      },
      {
        path: ["agents", "curator", "judgeEffort"],
        label: "Daily run: judge effort",
        kind: "select",
        options: EFFORTS,
      },
      {
        path: ["agents", "curator", "retractCalls"],
        label: "Daily run: retraction calls per run",
        kind: "number",
        help: "Rewrites of document sections citing a rule the run retires; 0 lists them instead",
      },
      ...agentFields("deepDive", "Deep dive"),
      {
        path: ["agents", "deepDive", "staleAfterDays"],
        label: "Deep dive: retire after (days unconfirmed)",
        kind: "number",
      },
      {
        path: ["agents", "deepDive", "retractCalls"],
        label: "Deep dive: retraction calls per run",
        kind: "number",
        help: "Rewrites of document sections citing a rule retired as stale; 0 lists them instead",
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
      {
        path: ["distribution", "docTokenBudget"],
        label: "Token budget for documents",
        kind: "number",
      },
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

/** `name: text` per line into a map; lines without a colon are skipped. */
const pairs = (s: string): Record<string, string> =>
  Object.fromEntries(
    s
      .split("\n")
      .map((l) => /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] ?? "", m[2] ?? ""]),
  );

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
  // A field whose value did not change is left untouched: defaults stay implicit, formatting stays.
  const before = parseConfig(yamlText).config;
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const unchanged = (path: readonly string[], value: unknown) =>
    before !== undefined && same(value, currentValue(before, { path } as Field));

  if (section.rows === "team") {
    const members = rowIndices(form, "member").flatMap((i) => {
      const id = form.get(`member.${i}.id`)?.trim();
      if (!id || form.get(`member.${i}.remove`)) return [];
      const handle = form.get(`member.${i}.handle`)?.trim();
      const slack = form.get(`member.${i}.slack`)?.trim();
      const areas = lines(form.get(`member.${i}.areas`) ?? "");
      return [
        {
          id,
          ...(handle ? { handle } : {}),
          ...(slack ? { slack } : {}),
          role: form.get(`member.${i}.role`) ?? "member",
          areas,
          ...(form.get(`member.${i}.optOut`) ? { optOut: true } : {}),
          ...(form.get(`member.${i}.usage`) ? { usage: true } : {}),
        },
      ];
    });
    if (!unchanged(["team", "members"], members))
      doc.setIn(["team", "members"], doc.createNode(members));
  } else if (section.rows === "teams") {
    const teams: Record<string, Record<string, unknown>> = {};
    for (const i of rowIndices(form, "teamrow")) {
      const name = form.get(`teamrow.${i}.name`)?.trim();
      if (!name || form.get(`teamrow.${i}.remove`)) continue;
      const handle = form.get(`teamrow.${i}.handle`)?.trim();
      teams[name] = {
        ...(handle ? { handle } : {}),
        members: lines(form.get(`teamrow.${i}.members`) ?? ""),
        areas: lines(form.get(`teamrow.${i}.areas`) ?? ""),
        repos: lines(form.get(`teamrow.${i}.repos`) ?? ""),
      };
    }
    if (Object.keys(teams).length) doc.setIn(["teams"], doc.createNode(teams));
    else if (doc.has("teams")) doc.delete("teams");
  } else if (section.rows === "repos") {
    const repos: Record<string, unknown> = {};
    for (const i of rowIndices(form, "repo")) {
      const name = form.get(`repo.${i}.name`)?.trim();
      if (!name || form.get(`repo.${i}.remove`)) continue;
      const areas = Object.fromEntries(
        Object.entries(pairs(form.get(`repo.${i}.areas`) ?? "")).map(([a, globs]) => [
          a,
          lines(globs),
        ]),
      );
      const topics = pairs(form.get(`repo.${i}.topics`) ?? "");
      repos[name] = {
        source: form.get(`repo.${i}.source`)?.trim() ?? "",
        ...(Object.keys(areas).length ? { areas } : {}),
        ...(Object.keys(topics).length ? { topics } : {}),
      };
    }
    if (Object.keys(repos).length === 0) {
      if (doc.hasIn(["repos"])) doc.deleteIn(["repos"]);
    } else if (!unchanged(["repos"], repos)) doc.setIn(["repos"], doc.createNode(repos));
  } else if (section.rows === "areas") {
    const areas: Record<string, string[]> = {};
    for (const i of rowIndices(form, "area")) {
      const name = form.get(`area.${i}.name`)?.trim();
      if (!name || form.get(`area.${i}.remove`)) continue;
      areas[name] = lines(form.get(`area.${i}.globs`) ?? "");
    }
    if (!unchanged(["areas"], areas)) doc.setIn(["areas"], doc.createNode(areas));
  } else {
    for (const field of section.fields ?? []) {
      const name = field.path.join(".");
      const raw = form.get(name);
      if (field.path.join(".") === "sources.host" && !raw) {
        doc.deleteIn(["sources"]);
        break;
      }
      // An empty number, optional list or optional text means "use the default": the key goes.
      const clear =
        (field.kind === "number" && (raw === null || raw === "")) ||
        (field.kind === "lines" && field.optional && lines(raw ?? "").length === 0) ||
        (field.kind === "pairs" && field.optional && Object.keys(pairs(raw ?? "")).length === 0) ||
        (field.kind !== "checkbox" &&
          field.kind !== "checks" &&
          field.kind !== "lines" &&
          field.kind !== "number" &&
          field.optional &&
          !raw?.trim());
      if (clear) {
        if (doc.hasIn(field.path)) doc.deleteIn(field.path);
        continue;
      }
      const value =
        field.kind === "checkbox"
          ? form.get(name) === "on"
          : field.kind === "checks"
            ? form.getAll(name)
            : field.kind === "lines"
              ? lines(raw ?? "")
              : field.kind === "pairs"
                ? pairs(raw ?? "")
                : field.kind === "number"
                  ? Number(raw)
                  : raw?.trim();
      if (value === undefined || unchanged(field.path, value)) continue;
      doc.setIn(field.path, Array.isArray(value) ? doc.createNode(value) : value);
    }
  }

  // Drop sections that became empty maps, so the defaults apply.
  for (const key of ["notifications", "distribution", "scoring", "security"]) {
    const node = doc.get(key, true);
    if (isMap(node) && node.items.length === 0) doc.delete(key);
  }

  const text = doc.toString({ flowCollectionPadding: false });
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
