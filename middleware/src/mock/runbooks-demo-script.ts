// The script of the Runbooks demo (mock/runbooks-demo.ts): who does what, in
// which beat, and the words they use. Kept apart from the director so the
// copy can be read, and judged by a peer's eye, without the machinery.
//
// The story, in one paragraph. Nora DaSilva sends Basil, an agent, to sequence
// the remaining tenants for the SAML cutover on Auth Migration. Basil is handed
// the runbook for bringing SSO up on a new origin and follows it, hits the
// redirect_mismatch the runbook only lists as a symptom, and writes down what
// would have prevented it as an edit to the runbook. Vera Green, who owns the
// runbook, reads the edit beside what it changes and accepts it. The next time
// Nora sends an agent (Cleo, on the refresh-loop bug), the brief that agent is
// handed carries the new version of the runbook, with the new step in it.
import { RUNBOOK_DOCS } from './runbooks.seed.js';
import type { RunbookDoc } from '../lib/runbooks/index.js';

export const RUNBOOK_ID = 'rb-sso-new-origin';

/** The people, by the id the rows carry. */
export const CAST = {
  nora: { user: 'u-nora', person: 'p-004', name: 'Nora DaSilva' },
  vera: { user: 'u-vera', person: 'p-002', name: 'Vera Green' },
} as const;

export interface DemoRun {
  agent: 'Basil' | 'Cleo';
  runRef: string;
  sessionId: string;
  workItemId: string;
  startBeat: number;
}

/** Basil's run is the one that finds the gap; Cleo's is the one that benefits. */
export const FIRST_RUN: DemoRun = { agent: 'Basil', runRef: 'run-basil-sso-origin', sessionId: 'sess-basil-sso-origin', workItemId: 'wi-auth-e2-s2', startBeat: 1 };
export const SECOND_RUN: DemoRun = { agent: 'Cleo', runRef: 'run-cleo-refresh-loop', sessionId: 'sess-cleo-refresh-loop', workItemId: 'wi-auth-e1-b4', startBeat: 13 };

/** Beats after the story starts. */
export const BEATS = { propose: 5, open: 8, accept: 10 } as const;

export const RATIONALE =
  'Basil followed this runbook to bring SSO up on a tenant\'s new address and every sign-in failed with redirect_mismatch right after the callback was set. '
  + 'The runbook lists that symptom but not the step that prevents it: the new address has to be on the Cognito app client\'s callback list first. '
  + 'This adds that as a step before the callback is set, and updates the step numbers the failure table points to.';

export const REVIEW_NOTE = 'Yes. The first rollout hit exactly this, and nobody wrote it down until now.';

/** The step the edit adds, as the proposal carries it. */
export const ADDED_STEP_DO = 'Add the new origin to the app client\'s callback list in Cognito.';

/** v1 plus the step, with the failure table's step numbers moved to match. */
export function proposedDoc(): RunbookDoc {
  const base = RUNBOOK_DOCS['rb-sso-new-origin@1'];
  if (!base) throw new Error('runbooks demo: the seeded SSO runbook is missing');
  const doc: RunbookDoc = structuredClone(base);
  doc.preconditions = [...doc.preconditions, 'You know the user pool id (`$POOL_ID`) and the app client id (`$CLIENT_ID`).'];
  doc.steps = [
    doc.steps[0]!, doc.steps[1]!, doc.steps[2]!,
    {
      do: ADDED_STEP_DO,
      command: { lang: 'bash', text: 'aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" \\\n  --client-id "$CLIENT_ID" --callback-urls "https://$NEW_HOST/api/auth/callback"' },
      expect: 'the response\'s `CallbackURLs` to list `https://$NEW_HOST/api/auth/callback`.',
      why: 'Without it Cognito sends every sign-in on the new address back with redirect_mismatch.',
    },
    doc.steps[3]!, doc.steps[4]!,
  ];
  doc.failure_modes = [
    { symptom: 'Every sign-in fails right after step 5', cause: 'The callback is http on a non-localhost origin', response: 'Roll back, finish step 3, then redo step 5' },
    { symptom: '`redirect_mismatch` from the hosted UI', cause: 'The new origin is not on the app client\'s callback list (step 4 skipped)', response: 'Redo step 4, then retry step 6' },
  ];
  return doc;
}

export function beatMs(): number {
  for (const name of ['RUNBOOKS_DEMO_PACE_MS', 'DEMO_PACE_MS']) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return process.env['NODE_ENV'] === 'test' ? 0 : 10_000;
}
