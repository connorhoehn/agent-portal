// The ONE way a sprint envelope (budget_grants row) comes into being.
//
// Two callers, one path: a release manager's `POST /api/grants`
// (routes/grants.ts) and the access tenant's provisioning of an approved
// `sprint-envelope` request (lib/access-provision.ts, 2026-10-28). Both write
// the row through providers/grants.ts `createGrant` and then ring the same
// two bells — the grantee's notification and the work graph's live hint — so
// an envelope granted by hand and one granted through an approval chain are
// indistinguishable to every reader (the Sprints page, the envelope brake,
// the dispatch gate).
//
// The notifications are imported lazily, as routes/grants.ts always did: the
// producer pulls the identity store, which the grants route's unit tests do
// not load. Neither bell may fail the grant.

import { createGrant, type CreateGrantInput } from '../providers/grants.js';
import type { GrantRow } from '../providers/budgets.js';

export interface GrantEnvelopeInput extends CreateGrantInput {
  /** The app user whose decision authorized the envelope (routes/grants.ts: the session; access: the final approver). */
  grantedBy: string | null;
}

export async function grantEnvelope(input: GrantEnvelopeInput): Promise<GrantRow> {
  const grant = await createGrant(input);
  void import('./social-notify.js')
    .then((m) => m.notifyBudgetGranted({
      grantId: grant.id, initiativeId: input.orgProjectId, sprintId: input.sprintId, granteePersonId: input.granteePersonId,
      amountUsd: input.amountUsd, actorId: input.grantedBy,
    }))
    .catch(() => undefined);
  void import('./work-graph/live.js').then((m) => m.notifyWorkGraphChanged(input.orgProjectId, 'sprint')).catch(() => undefined);
  return grant;
}
