// lib/runbooks — the runbook model (docs/distillation-runbooks-design.md §2–§3).
// Pure modules only; the stores (R1), routes (R3) and injection (R4) build on
// these exports. repo-context.ts is the one file here that reads the disk.
export type {
  ApplicationOutcome, BriefOmission, BriefSection, BriefSectionKind, CommandLang, HealthStatus, LintFinding, LintRuleId,
  Runbook, RunbookApplication, RunbookCommand, RunbookDoc, RunbookHealth, RunbookProposal, RunbookProvenance, RunbookScope,
  RunbookScopeKind, RunbookStatus, RunbookStep, RunbookTriggers, RunbookVersion, SessionBrief,
} from './types.js';
export { COMMAND_LANGS } from './types.js';
export { renderRunbook, formatProblems, RunbookFormatError, HEADINGS, type RunbookHeader } from './render.js';
export { parseRunbook, tryParseRunbook, RunbookParseError, type ParseError, type ParseResult } from './parse.js';
export { lintRunbook, lintErrors, LINT_RULES, LIMITS, IMPERATIVE_VERBS, MUTATING_VERBS, changesState, type LintContext, type LintRule } from './lint.js';
export { similarity, tokens, sharedTokens, runbookTerms, scopesOverlap, findSimilar, DEDUPE_THRESHOLD, type SimilarRunbook } from './similarity.js';
export { selectRunbooks, SCOPE_WEIGHT, type WorkItemContext, type RunbookCandidate, type SelectedRunbook, type Selection } from './select.js';
export {
  assembleBrief, briefBudget, ASSEMBLER_VERSION, DEFAULT_BRIEF_BUDGET, CONTEXT_CAP_TOKENS, MAX_FULL_RUNBOOKS,
  type AssembleBriefInput, type BriefWorkItem, type BriefInitiative, type BriefDecision,
} from './brief.js';
export { estimateTokens, sha256Hex } from './tokens.js';
export { runbookHealth, PROVEN_TTL_DAYS } from './health.js';
export { versionOf } from './version.js';
export * from './store.js';
export { RowsRunbookStore, privateRowSources, type RunbookRowSources } from './store-rows.js';
export { DynamoRunbookStore, runbookStoreConfig, ensureRunbookTable, dropRunbookTable, createRunbookDynamoClient, type RunbookStoreConfig } from './store-dynamo.js';
