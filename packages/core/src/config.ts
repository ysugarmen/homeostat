import { parseDocument } from "yaml";
import { z } from "zod";
import { CORE_AREA } from "./check.ts";
import { error, type Issue } from "./issues.ts";
import { ID_PATTERN } from "./schema.ts";
import { fromZod } from "./zod-issues.ts";

export const CONFIG_FILE = "kbx.yaml";

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

const agentSchema = (schedule: string) =>
  z.strictObject({ enabled: z.boolean().default(true), schedule: cron.default(schedule) });

export const EXPORT_TARGETS = ["claude", "cursor", "agents-md", "copilot"] as const;

export const configSchema = z.strictObject({
  version: z.literal(1),
  team: z.strictObject({
    members: z
      .array(
        z.strictObject({
          id: name,
          role: z.enum(["senior", "member"]),
          areas: z.array(z.string()).default([]),
          /** CODEOWNERS identity: `@user`, `@org/team` or an email. */
          handle: z
            .string()
            .regex(
              /^(@[\w.-]+(\/[\w.-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/,
              "handle must be @user, @org/team or an email",
            )
            .optional(),
        }),
      )
      .min(1),
  }),
  /** Area name → path globs. `core` is implicit and global. */
  areas: z.record(name, z.array(z.string().min(1)).min(1)),
  scoring: z
    .strictObject({
      weights: weightsSchema.prefault({}),
      autoMergeThreshold: z.int().default(3),
      reviewCadence: z.enum(["daily", "weekly", "biweekly"]).default("weekly"),
    })
    .prefault({}),
  agents: z
    .strictObject({
      curator: agentSchema("0 6 * * *").prefault({}),
      deepDive: agentSchema("0 7 * * 1").prefault({}),
      /** Session handoff notes, asked for by the plugin's Stop hook. Runs in sessions, not on a schedule. */
      handoff: z
        .strictObject({
          enabled: z.boolean().default(true),
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
});

export type Config = z.infer<typeof configSchema>;

const RENAMED_KEYS = { verticals: "areas", slackWebhook: "slackWebhookEnv" };

/** Parses and checks `kbx.yaml`. Returns `config` only when there are no errors. */
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
      if (area !== CORE_AREA && !Object.hasOwn(config.areas, area)) {
        issues.push(
          error("config.member.area", `team.members.${i}.areas: "${area}" is not in areas`, {
            path: `team.members.${i}.areas`,
            file,
          }),
        );
      }
    }
  });

  return issues.length ? { issues } : { config, issues };
}
