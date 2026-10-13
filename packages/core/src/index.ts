export { type BodySections, parseBody, RULE_MAX_WORDS, WHY_MAX_WORDS } from "./body.ts";
export { type CheckContext, CORE_AREA, checkEntry } from "./check.ts";
export { CODEOWNERS_FILE, generateCodeowners } from "./codeowners.ts";
export {
  CONFIG_FILE,
  type Config,
  configSchema,
  DEFAULT_WEIGHTS,
  EXPORT_TARGETS,
  parseConfig,
  type Weights,
} from "./config.ts";
export {
  type Conflict,
  type ConflictKind,
  detectConflicts,
  scopesOverlap,
  TITLE_SIMILARITY,
  titleSimilarity,
} from "./conflicts.ts";
export { type Entry, formatEntry, parseEntry } from "./entry.ts";
export { applyFixes } from "./fix.ts";
export { error, type Fix, hasErrors, type Issue, type Severity } from "./issues.ts";
export * from "./providers/index.ts";
export {
  type Frontmatter,
  frontmatterSchema,
  ID_PATTERN,
  SOURCE_TYPES,
  type SourceType,
  STATUSES,
  type Status,
  sourceSchema,
} from "./schema.ts";
export { type ScoreContext, type ScoreReason, type ScoreResult, score } from "./score.ts";
export { countTokens } from "./tokens.ts";
export { type KbFiles, type ValidatedEntry, type ValidateResult, validate } from "./validate.ts";
