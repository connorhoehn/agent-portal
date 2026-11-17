// Milo's recap (docs/interviews-tenant-plan.md row I5.2; contract E3).
//
//   openRecap / readRecap / ratingsAtRecap   for routes/interviews/recap.ts and routes/interviews/scorecards.ts
//   setRecapDeps                             E1: the integrator points `transcript` at the record's reader
//   eraseRecaps                              E7: the integrator registers it as a `record`-class eraser
//   exportRecap                              E8: the integrator registers it as an export section
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { eraseRecapRows, exportRecapRows } from './service.js';

export { RECAP_PROMPT_VERSION, RECAP_SYSTEM_PROMPT, buildRecapRequest, recapUserText, type RecapInput } from './prompt.js';
export { guardRecapText, parseRecapAnswer, RECAP_JUDGES, type RecapContent } from './parse.js';
export { BedrockRecapModel, ScriptedRecapModel, makeRecapModel, RECAP_TIMEOUT_MS, type RecapModel } from './model.js';
export { recapStore, setRecapStore, type OpenRating, type RecapOpen, type RecapRecord, type RecapStore } from './store.js';
export {
  checkOpenRatings, openRecap, ratingsAtRecap, readRecap, recapBody, setRecapDeps, RECAP_MAX_ATTEMPTS,
  type RecapBody, type RecapDeps, type RecapRef,
} from './service.js';

/** E7: remove these interviews' recaps and the opens of them; how many rows went. Runs in the interviews tenant's db context. */
export async function eraseRecaps(interviewIds: readonly string[]): Promise<number> {
  if (!interviewIds.length) return 0;
  return runWithDbTenant(INTERVIEWS_TENANT, () => eraseRecapRows(interviewIds));
}

/** E8: the interview's recap as kept (with its model, prompt version and dropped-attempt codes) and who opened it, when. */
export async function exportRecap(interviewId: string): Promise<unknown> {
  return runWithDbTenant(INTERVIEWS_TENANT, () => exportRecapRows(interviewId));
}
