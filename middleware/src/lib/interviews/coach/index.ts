// The coach module (docs/interviews-tenant-plan.md row I3.3; contracts D6 and D7).
//
//   suggestionFor / answerSuggestion   D7, for routes/interviews/coach.ts
//   eraseSuggestions                   D6, for retention: the integrator registers it as a `record`-class eraser
//
// Rows I3.5 (speech), I3.6 ("Milo for you"), I3.10 (the question plan) and I5.2 (the recap) reuse the model seam
// (model.ts), the request-as-data and strict-answer pattern (prompt.ts, parse.ts, the guard) and the log (store.ts).
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { eraseSuggestionRows } from './service.js';

export { COACH_PROMPT_VERSION, COACH_SYSTEM_PROMPT, buildCoachRequest, coachUserText, type CoachInput, type CoachLine } from './prompt.js';
export { guardSuggestion, parseCoachAnswer, JUDGES, PERSONAL, type CoachSuggestion, type DropCode } from './parse.js';
export { BedrockCoachModel, ScriptedCoachModel, coachModelId, makeCoachModel, setCoachModelFactory, DEFAULT_COACH_MODEL_ID, COACH_TIMEOUT_MS, type CoachModel } from './model.js';
export { decideCoach, MAX_ATTEMPTS_PER_INTERVIEW, SUGGESTION_GAP_MS, type CoachDecision, type CoachFacts } from './rules.js';
export { suggestionStore, setSuggestionStore, SUGGESTION_ANSWERS, type SuggestionAnswer, type SuggestionRecord, type SuggestionStore } from './store.js';
export { answerSuggestion, setCoachDeps, suggestionFor, suggestionView, type CoachRef, type SuggestionBody, type SuggestionView } from './service.js';

/** D6: remove these interviews' rows from the suggestion log; how many went. Runs in the interviews tenant's db context. */
export async function eraseSuggestions(interviewIds: readonly string[]): Promise<number> {
  if (!interviewIds.length) return 0;
  return runWithDbTenant(INTERVIEWS_TENANT, () => eraseSuggestionRows(interviewIds));
}
