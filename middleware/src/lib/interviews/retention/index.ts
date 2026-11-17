// The retention module (docs/interviews-tenant-plan.md decision 17, row I6.3). See service.ts for what a deletion and
// the sweep do, rules.ts for the classes, registry.ts for contract D6.
export { registerEraser, type Eraser } from './registry.js';
export { deleteCandidateMedia, deletionsOf, startInterviewsRetentionSweep, sweep } from './service.js';
export { retentionPeriods, type RetentionPeriods } from './periods.js';
export type { DeletionRow } from './store.js';
