import { z } from "zod";

export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const id = z.string().regex(ID_PATTERN, "must be lowercase letters, digits and single hyphens");
const memberId = z.string().min(1);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "must be a real calendar date");

/** What kind of knowledge a rule is; agents get one line of guidance per kind. */
export const KINDS = [
  "convention",
  "anti-pattern",
  "review-lesson",
  "migration",
  "legacy",
  "tech-debt",
  "practice",
  "decision",
] as const;

export const STATUSES = ["candidate", "accepted", "disputed", "retired"] as const;
export const SOURCE_TYPES = ["pr-feedback", "manual", "agent-handoff", "deep-dive"] as const;

export const sourceSchema = z.strictObject({
  type: z.enum(SOURCE_TYPES),
  url: z.url({ protocol: /^https?$/ }).optional(),
  author: memberId,
  changedCode: z.boolean().optional(),
});

/**
 * Shape of an entry's frontmatter. Rules that span fields or need the config live in
 * `entry.ts` and `check.ts`; this schema is also exported as `schema/entry.schema.json`.
 */
export const frontmatterSchema = z.strictObject({
  id,
  title: z.string().min(1, "must not be empty").max(80, "must be at most 80 characters"),
  area: z.string().min(1),
  scope: z
    .array(z.string().min(1))
    .min(1, 'must list at least one path glob; use ["**"] for global'),
  status: z.enum(STATUSES),
  score: z.int(),
  owner: memberId,
  source: sourceSchema,
  created: isoDate,
  lastConfirmed: isoDate,
  approvedBy: memberId.optional(),
  /**
   * The member who read this entry's risky-content findings (see `risk.ts`) and judged it safe,
   * e.g. a rule that says never to disable TLS. Without it, any finding fails validation.
   */
  riskReviewedBy: memberId.optional(),
  conflictsWith: z.array(id).optional(),
  supersedes: id.optional(),
  tags: z.array(z.string().min(1)).optional(),
  kind: z.enum(KINDS).optional(),
  /**
   * With kind decision: false records a proposal the team discussed and rejected. It is never
   * injected as a rule; search and explain show it as context so agents stop re-proposing it.
   */
  adopted: z.boolean().optional(),
  /** "This is wrong" reports; each costs the entry score and sends it back to review. */
  flags: z
    .array(z.strictObject({ by: memberId, reason: z.string().min(1), date: isoDate }))
    .optional(),
  tokens: z.int().min(0),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;
export type Status = (typeof STATUSES)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type Kind = (typeof KINDS)[number];

/** A decision the team considered and chose not to adopt: context, never an instruction. */
export const isRejectedDecision = (fm: Pick<Frontmatter, "kind" | "adopted">) =>
  fm.kind === "decision" && fm.adopted === false;
