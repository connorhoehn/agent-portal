import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page, DIFF_KEY_WARNING } from '../_shared.ts';

// Vera Green owns Auth Migration and its cutover runbook. She opens the edit a
// run proposed, reads the diff against v1, and accepts: the runbook moves to v2
// and the proposal is closed with her name on it. Runs in a scoped copy of the
// default world, so the accept stays in the scope.
export default {
  family: 'runbooks', log: 'reviewer/accept', kind: 'journey', persona: P.vera, scenario: { scope: 'default' }, writes: true, identity: 'clone',
  goal: 'Read a run’s proposed edit against the version it changes and accept it, so the runbook gains a new version',
  fields: { surface: 'accept a proposal', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks/proposals/prop-tenant-cutover-callback', 'The owner sees the diff, the lint result and Apply change and Reject on the run’s proposal',
      ['SAML to Cognito migration', /against v1/], { expectConsole: DIFF_KEY_WARNING, expect: { visible: [{ testId: 'proposal-diff' }, { testId: 'proposal-card' }], noText: [/You can read this proposal, not decide it/] } }),
    { do: 'click', target: { role: 'button', name: 'Apply change', within: { testId: 'proposal-card' } }, audit: true, writes: true, proves: 'gating', expectConsole: DIFF_KEY_WARNING,
      name: 'Accepting closes the proposal and leaves the runbook at its next version',
      expect: { visible: [{ testId: 'proposal-decided' }] } },
    page('/iq/runbooks/rb-tenant-cutover', 'The runbook is now at its next version, v2', [/ v2 /]),
  ],
} satisfies JourneyMap;
