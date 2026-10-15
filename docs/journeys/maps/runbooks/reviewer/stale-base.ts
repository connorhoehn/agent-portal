import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page, DIFF_KEY_WARNING } from '../_shared.ts';

// A reviewer who looked at v1 cannot accept onto a runbook that has moved to v2.
// The route answers 409 and writes nothing; the portal tells the reviewer the
// proposal needs a fresh base.
export default {
  family: 'runbooks', log: 'reviewer/stale-base', kind: 'journey', persona: P.vera, scenario: 'shared', identity: 'clone',
  goal: 'Try to accept an edit written against an older version of the runbook and be refused, with nothing changed',
  fields: { surface: 'a stale proposal', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks/proposals/prop-tenant-cutover-callback', 'The proposal is open against v1 and the runbook is at v1',
      [/against v1/], { expectConsole: DIFF_KEY_WARNING }),
    { do: 'api', method: 'POST', url: '/api/runbooks/proposals/prop-tenant-cutover-callback/accept', body: { expected_version: 7 },
      refusal: 'the reviewer’s expected version (v7) is not the runbook’s current one, so the route answers 409 before it writes anything', proves: 'gating',
      name: 'Accepting while believing the runbook is at another version is refused', expect: { status: 409 } },
    page('/iq/runbooks/proposals/prop-tenant-cutover-callback', 'The refused accept left the proposal open',
      [/Open|Pending/i], { expectConsole: DIFF_KEY_WARNING, expect: { visible: [{ testId: 'proposal-card' }], absent: [{ testId: 'proposal-decided' }] } }),
  ],
} satisfies JourneyMap;
