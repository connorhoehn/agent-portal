// Whether the scorecard page shows "Milo recommends" (ledger row C-9, decision of 28 November). The advice is computed in
// the browser, stored nowhere and in no export, and the one notice candidates accept says the assistant does not recommend,
// so it is off until a stored, exported version exists and the notice covers it. INTERVIEWS_MILO_RECOMMENDATION: `on` or
// `off`; anything else (or nothing) is off. Read on every request; never throws. Read-only in Settings.
export const MILO_RECOMMENDATION_SETTING = 'INTERVIEWS_MILO_RECOMMENDATION';

/** True only when the deployment sets the value to `on`. */
export function miloRecommendationShown(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MILO_RECOMMENDATION_SETTING]?.trim().toLowerCase() === 'on';
}
