// Milo for you (docs/interviews-tenant-plan.md rows I3.6 and I3.7; contracts E0, E5, E7, E8).
//
//   transcriptFor / notesFor / askMilo   E5, for routes/interviews/milo.ts
//   eraseCoachLog                        E7: the integrator registers it as a `record`-class eraser
//   exportCoachLog                       E8: the integrator registers it as an export section
//   BedrockMiloModel, coachLogStore      for the question plan (row I3.10): its own request through `converse`, its rows
//                                        through `append` with `kind: 'plan'`
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { coachLogStore } from './store.js';

export { ASK_PROMPT_VERSION, ASK_SYSTEM_PROMPT, NOT_SAID, buildAskRequest, askUserText, type AskInput } from './prompt.js';
export { parseAskAnswer, type AskAnswer, type AskSource, type AskDropCode } from './parse.js';
export { BedrockMiloModel, ScriptedMiloModel, makeMiloModel, estimateAskTokens, type MiloModel, type MiloModelResult } from './model.js';
export {
  coachLogStore, setCoachLogStore, COACH_LOG_CODES, COACH_LOG_KINDS,
  type CoachLogCode, type CoachLogKind, type CoachLogRecord, type CoachLogSource, type CoachLogStore,
} from './store.js';
export { askMilo, notesFor, setMiloDeps, transcriptFor, type AskBody, type AskOutcome, type MiloDeps, type MiloRef, type TranscriptBody } from './service.js';
export { ASK_GAP_MS, MAX_ASKS_PER_INTERVIEW, FIXED_ANSWER, checkQuestion, precheckQuestion } from './rules.js';
export { competencyNotes, timeCheck, type MiloNotesView } from './notes.js';

/** E7: remove these interviews' rows from the coach log; how many went. Runs in the interviews tenant's db context. */
export async function eraseCoachLog(interviewIds: readonly string[]): Promise<number> {
  if (!interviewIds.length) return 0;
  return runWithDbTenant(INTERVIEWS_TENANT, () => coachLogStore().erase(interviewIds));
}

/** E8: one interview's coach log as logged (private answers and plans), oldest first. */
export async function exportCoachLog(interviewId: string): Promise<unknown> {
  const rows = await runWithDbTenant(INTERVIEWS_TENANT, () => coachLogStore().list(interviewId));
  return { rows };
}
