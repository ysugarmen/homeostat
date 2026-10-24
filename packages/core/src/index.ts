export {
  candidatesBranch,
  type Decision,
  type DecisionRecord,
  type DecisionsFile,
  decisionsPath,
  HEARTBEAT_PATH,
  type Heartbeat,
  lessonHash,
  REVIEW_REMINDER_DAYS,
  type RunReport,
  STALE_HEARTBEAT_HOURS,
  STATE_BRANCH,
  type UsageDay,
} from "./automation.ts";
export {
  type AutoMergeDecision,
  autoMergeDecision,
  type MergeCandidate,
  splitAutoMerge,
} from "./automerge.ts";
export { type BodySections, parseBody, RULE_MAX_WORDS, WHY_MAX_WORDS } from "./body.ts";
export {
  BOOTSTRAP_PARTS,
  type BootstrapPart,
  docTopic,
  type Estimate,
  estimate,
  existingDocs,
  PART_TOPICS,
  SEED_OUTPUT_TOKENS,
} from "./bootstrap.ts";
export { type CheckContext, CORE_AREA, checkEntry } from "./check.ts";
export {
  type ApiAskerOptions,
  type Asker,
  apiAsker,
  type ClaudeClient,
  ClaudeUnavailableError,
  type Effort,
} from "./claude.ts";
export {
  AGENT_ENV,
  type ClaudeCodeAskerOptions,
  type CommandRunner,
  claudeCodeArgs,
  claudeCodeAsker,
  type RunResult,
} from "./claude-code.ts";
export {
  bedrockAsker,
  bedrockModelId,
  type CloudAskerOptions,
  type CloudClient,
  vertexAsker,
} from "./cloud.ts";
export { CODEOWNERS_FILE, codeownersFile, generateCodeowners } from "./codeowners.ts";
export {
  type Confidence,
  type ConfidenceInput,
  confidence,
  explainConfidence,
} from "./confidence.ts";
export {
  CONFIG_FILE,
  type Config,
  configSchema,
  DEFAULT_AGENT_MODEL,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_WEIGHTS,
  EXPORT_TARGETS,
  isSenior,
  judgeModelFor,
  parseConfig,
  ROLES,
  type Role,
  type Weights,
} from "./config.ts";
export {
  type Conflict,
  type ConflictKind,
  codeReferences,
  detectConflicts,
  distinctFacts,
  identifiersIn,
  numbersIn,
  sameLesson,
  scopesOverlap,
  TITLE_SIMILARITY,
  titleSimilarity,
} from "./conflicts.ts";
export {
  applyUpdate,
  CANDIDATE_SIMILARITY,
  ClaudeConsolidator,
  CONSOLIDATE_SYSTEM,
  type Consolidator,
  consolidatePrompt,
  MAX_CANDIDATES,
  mergeCandidates,
  type PoolRule,
  parseVerdict,
  type RuleCandidate,
  type Verdict,
  verdictSchema,
} from "./consolidate.ts";
export {
  type AgentName,
  cronMatches,
  digestCron,
  digestDue,
  dueAgents,
  nextRun,
} from "./cron.ts";
export {
  type CuratedEntry,
  CurateError,
  type CurateInput,
  type CurateResult,
  curate,
  type DocUpdate,
  type Skipped,
} from "./curator/curate.ts";
export {
  ClaudeDocPatcher,
  DOC_PATCH_SYSTEM,
  type DocCandidate,
  type DocPatcher,
  type DocProposal,
  docPatchPrompt,
  docPatchSchema,
} from "./curator/doc-patcher.ts";
export {
  ClaudeDrafter,
  DRAFT_SYSTEM,
  type Draft,
  type DraftContext,
  type Drafter,
  draftPrompt,
  draftSchema,
} from "./curator/draft.ts";
export {
  ClaudeDraftJudge,
  DRAFT_JUDGE_SYSTEM,
  type DraftJudge,
  describeProblems,
  draftJudgePrompt,
  draftJudgeSchema,
  JUDGE_CONFIRMATIONS,
  JUDGE_TRAPS,
  type JudgedDraft,
  type JudgeInput,
  type JudgeProblem,
  type JudgeTrap,
  type JudgeVerdict,
  judgeDraft,
  parseJudgeVerdict,
} from "./curator/judge.ts";
export { type ReviewThread, reviewThreads } from "./curator/threads.ts";
export {
  type CommentRef,
  CommentUrlError,
  commentKey,
  commentKeyOf,
  parseCommentUrl,
} from "./curator/urls.ts";
export {
  ClaudeConflictJudge,
  ClaudeMerger,
  type ConflictJudge,
  type DeepDiveAction,
  type DeepDiveChange,
  DeepDiveError,
  type DeepDiveInput,
  type DeepDiveResult,
  deepDive,
  JUDGE_SYSTEM,
  judgePrompt,
  MERGE_SYSTEM,
  type Merger,
  mergePrompt,
  type RuleText,
} from "./deepdive.ts";
export { explainEntry, hitLine, kbReport } from "./describe.ts";
export { buildDigest, type DigestInput } from "./digest.ts";
export {
  ClaudeRuleFixer,
  FIX_SYSTEM,
  type FixedRule,
  fixProblems,
  fixPrompt,
  type RuleFixer,
  resolveDispute,
} from "./dispute.ts";
export {
  citationLoops,
  citedDocument,
  DOC_SECTION_MAX_WORDS,
  type Doc,
  type DocFrontmatter,
  type DocSection,
  docFrontmatterSchema,
  formatDoc,
  formatProvenance,
  isDocPath,
  PROVENANCE_SOURCES,
  type Provenance,
  parseDoc,
  parseProvenance,
} from "./doc.ts";
export {
  type ContextDoc,
  type DocContext,
  docContext,
  docCovers,
  docRef,
} from "./doc-context.ts";
export { type ConvertOptions, convertDoc } from "./doc-convert.ts";
export { mergeDocText } from "./doc-merge.ts";
export { applySectionPatch, changedSections, PatchError, type SectionPatch } from "./doc-patch.ts";
export { type Entry, formatEntry, parseEntry } from "./entry.ts";
export {
  describeEvent,
  EVENTS_DB,
  type Event,
  type EventQuery,
  formatEvent,
  LEGACY_EVENTS,
  logEvent,
  logFailure,
  logTurnUsage,
  pruneEvents,
  readEvents,
} from "./events.ts";
export {
  BLOCK_FILES,
  type ExportDoc,
  type ExportOutput,
  type ExportTarget,
  exportRules,
  OWNED_DIRS,
} from "./export.ts";
export { BLOCK_END, BLOCK_START, removeBlock, replaceBlock } from "./export-block.ts";
export {
  PENDING_DIR,
  readKbFiles,
  readKbView,
  readPendingFiles,
  removePendingFile,
  writeKbFile,
  writePendingFile,
} from "./files.ts";
export { applyFixes } from "./fix.ts";
export { type Flag, flagEntry } from "./flag.ts";
export {
  CREDIT_LABEL,
  PROMPT_GUIDE,
  parseCredits,
  RETRIEVAL_TOOLS,
  sessionGuide,
  TRIGGER_MOMENTS,
} from "./guide.ts";
export { codeownersHandle, loginKey, memberForLogin, memberFromGit } from "./handles.ts";
export { error, type Fix, hasErrors, type Issue, type Severity } from "./issues.ts";
export {
  areaMap,
  areasOf,
  comparable,
  docFilePath,
  isKnownArea,
  isMultiRepo,
  type KbLocation,
  locate,
  RESERVED_REPO_NAMES,
  repoForSource,
  repoNames,
  repoOf,
  ruleFilePath,
} from "./layout.ts";
export {
  type Calibration,
  type CalibrationBand,
  calibration,
  wasReview,
} from "./metrics/calibration.ts";
export {
  type DecisionsMetrics,
  type DecisionTotals,
  decisionsMetrics,
  isDuplicate,
} from "./metrics/decisions.ts";
export {
  type HealthPoint,
  healthTrend,
  type KbSnapshot,
  kbSnapshot,
} from "./metrics/health-trend.ts";
export { type MetricsReport, metricsReport } from "./metrics/index.ts";
export { type OpenReview, type ReviewLatency, reviewLatency } from "./metrics/latency.ts";
export { type Reach, reach } from "./metrics/reach.ts";
export { type Runtime, runtime } from "./metrics/runtime.ts";
export { type TurnMetrics, turnMetrics } from "./metrics/turns.ts";
export {
  type DailyCount as MetricsDailyCount,
  DEFAULT_WINDOW,
  type MetricsSnapshot,
  type Percentiles,
} from "./metrics/types.ts";
export { usageCounts } from "./metrics/usage.ts";
export { percentiles } from "./metrics/util.ts";
export {
  ClaudeTopicProposer,
  type MigrationPlan,
  type MigrationResult,
  migratedPath,
  migrateKb,
  TOPICS_SYSTEM,
  type TopicProposer,
} from "./migrate.ts";
export * from "./providers/index.ts";
export { detectRepo, remoteRepo, repoFor } from "./repo-detect.ts";
export {
  type Citation,
  ClaudeRetractor,
  citesId,
  findCitations,
  RETRACT_SYSTEM,
  type RetiredRule,
  type RetractedDoc,
  type Retraction,
  type RetractionInput,
  type Retractor,
  type RetractResult,
  retiredRule,
  retractCitations,
  retractionSchema,
  retractPrompt,
} from "./retract.ts";
export {
  aggregate as aggregateRetrieval,
  CUTOFFS,
  hitAt,
  mostReachGold,
  ndcgAt,
  precisionAt,
  type QueryScore,
  type RunScore,
  recallAt,
  reciprocalRank,
  rPrecision,
  scoreQuery,
} from "./retrieval-metrics.ts";
export { RISK_ADVICE, type RiskFinding, scanRisk } from "./risk.ts";
export {
  type Frontmatter,
  frontmatterSchema,
  ID_PATTERN,
  isRejectedDecision,
  KINDS,
  type Kind,
  SOURCE_TYPES,
  type SourceType,
  STATUSES,
  type Status,
  sourceSchema,
} from "./schema.ts";
export { type ScoreContext, type ScoreReason, type ScoreResult, score } from "./score.ts";
export {
  type SearchHit,
  type SearchOptions,
  type SectionHit,
  searchEntries,
  searchSections,
  snippet,
  tokenize,
} from "./search.ts";
export { findEmails, redactSecrets, type SecretFinding, scanSecrets } from "./secrets.ts";
export { type SectionUsage, sectionUsage } from "./section-usage.ts";
export {
  ClaudeSeeder,
  DATA_FILES,
  type FilePicker,
  INFRA_FILES,
  isSecretManifest,
  KEY_FILES,
  NEVER_READ,
  type RepoSnapshot,
  SEED_PICKERS,
  SEED_SYSTEM,
  SEED_TOPICS,
  type SeedDraft,
  type Seeder,
  type SeedTopic,
  seedDoc,
  seedPrompt,
  seedSchema,
  snapshotRepo,
} from "./seed.ts";
export {
  CONTEXT_HEADER,
  fileRefs,
  KIND_GUIDANCE,
  renderContext,
  restCounts,
  type SelectedEntry,
  type Selection,
  type SelectOptions,
  selectEntries,
} from "./select.ts";
export {
  type CaseResult,
  EVAL_FILE,
  EVAL_SEARCH_LIMIT,
  type EvalCase,
  type EvalOptions,
  type EvalPool,
  type EvalReport,
  evalCaseSchema,
  evalFileSchema,
  parseEvalCases,
  runSelectionEval,
  type Surface,
  type SurfaceReport,
} from "./selection-eval.ts";
export { slugify } from "./slug.ts";
export { readState, type StateView } from "./state.ts";
export { countTokens } from "./tokens.ts";
export {
  findRule,
  foldRules,
  formatTopicFile,
  GENERAL_TOPIC,
  isTopicFile,
  matchTopic,
  mergeTopicFile,
  overlayPending,
  parseTopicFile,
  rulePath,
  ruleSection,
  type TopicMeta,
  type TopicSection,
  topicFilePath,
  topicsFor,
  usesTopics,
} from "./topics.ts";
export {
  addCredits,
  homeostatTool,
  readLinesFrom,
  summarizeTurns,
  type TurnUsage,
} from "./turn-usage.ts";
export {
  type KbFiles,
  type ValidatedDoc,
  type ValidatedEntry,
  type ValidateResult,
  validate,
} from "./validate.ts";
export { VERSION } from "./version.ts";
export { exportable, inRepo, isTeamOnly, visibleTo } from "./visibility.ts";
