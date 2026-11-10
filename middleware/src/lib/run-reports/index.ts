// lib/run-reports — the run report (docs/learning-loop-design.md §1): its
// shape, the tolerant self-report parser, use detection, the store and the one
// function every executor's completion point calls.
export * from './types.js';
export { LAB_REPORT_ASK, parseLabReport, extractLabReportBlock, cleanText, type ParsedSelfReport } from './self-report.js';
export { skillsLoadedByEvent, skillsLoadedFrom, SKILL_NAME_RE } from './use-detection.js';
export type { RunReportStore, ListRunReportsQuery, StagedWorkerPart } from './store.js';
export { RowsRunReportStore, privateRunReportSources, type RunReportRowSources } from './store-rows.js';
export { DynamoRunReportStore } from './store-dynamo.js';
export {
  recordRunEnd, onRunReportSaved, outcomeOfJobStatus, failureCodeOf, numstatFromDiff, normalizeWorkerPart, offeredFromBrief, applicationId,
  type RunEndInput, type RecordDeps,
} from './record.js';
