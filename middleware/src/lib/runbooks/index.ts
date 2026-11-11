// lib/runbooks — the runbook model.
// Pure modules only; the stores (R1), routes (R3) and injection (R4) build on
// these exports. repo-context.ts is the one file here that reads the disk.
export type {
  ApplicationOutcome, BriefAttemptRef, BriefOffer, BriefOfferedRunbook, BriefOmission, BriefSection, BriefSectionKind, CommandLang, HealthStatus, LintFinding, LintRuleId,
  Runbook, RunbookApplication, RunbookCommand, RunbookDoc, RunbookHealth, RunbookProposal, RunbookProvenance, RunbookScope,
  RunbookFile, RunbookScopeKind, RunbookStatus, RunbookStep, RunbookTriggers, RunbookVersion, SessionBrief,
} from './types.js';
export { COMMAND_LANGS } from './types.js';
export { renderRunbook, formatProblems, RunbookFormatError, HEADINGS, type RunbookHeader } from './render.js';
export { parseRunbook, tryParseRunbook, RunbookParseError, type ParseError, type ParseResult } from './parse.js';
export { lintRunbook, lintErrors, bundlePaths, declaresRuntime, SKILL_COLLISION_THRESHOLD, LINT_RULES, LIMITS, IMPERATIVE_VERBS, MUTATING_VERBS, changesState, type LintContext, type LintRule } from './lint.js';
export { similarity, tokens, sharedTokens, runbookTerms, scopesOverlap, findSimilar, DEDUPE_THRESHOLD, type SimilarRunbook } from './similarity.js';
export { selectRunbooks, scopeMatch, readableReason, noneReason, SCOPE_WEIGHT, MAX_GIVEN_RUNBOOKS, type WorkItemContext, type RunbookCandidate, type SelectedRunbook, type Selection } from './select.js';
export {
  assembleBrief, briefBudget, skillsPointer, fenceNote, healthWarning, derivedFenceToken, ASSEMBLER_VERSION, DEFAULT_BRIEF_BUDGET,
  DECISIONS_CAP_TOKENS, MAX_PREVIOUS_ATTEMPTS, ATTEMPT_LIMITS,
  type AssembleBriefInput, type BriefPreviousAttempt, type BriefSkillLibrary, type BriefWorkItem, type BriefInitiative, type BriefDecision, type BriefSkill,
} from './brief.js';
export { estimateTokens, sha256Hex } from './tokens.js';
export { runbookHealth, PROVEN_TTL_DAYS } from './health.js';
export { versionOf } from './version.js';
export * from './store.js';
export { RowsRunbookStore, privateRowSources, type RunbookRowSources } from './store-rows.js';
export { DynamoRunbookStore, runbookStoreConfig, ensureRunbookTable, dropRunbookTable, createRunbookDynamoClient, type RunbookStoreConfig } from './store-dynamo.js';
export { FILE_LIMITS, FILE_ROOTS, RunbookFileError, checkFilePath, fileOf, filesOf, sortFiles, bundleSha, fileManifest, byteLength } from './files.js';
export { renderSkill, parseSkill, skillDescription, checkSkillName, checkSkillDescription, SKILL_LIMITS, SKILL_NAME, PORTABLE_FRONTMATTER_KEYS, type SkillParse } from './skill.js';
export { buildSkillLibrary, loadSkillLibrary, loadFrozenSkillLibrary, skillLibraryForRun, librarySha, briefLibraryOf, LIBRARY_FORMAT, BOX_SKILLS_DIR, PROJECT_SKILLS_DIR, type SkillLibrary, type LibrarySkill, type LibraryFile } from './library.js';
