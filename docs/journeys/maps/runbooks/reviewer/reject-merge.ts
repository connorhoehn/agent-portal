import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page, DIFF_KEY_WARNING } from '../_shared.ts';

// Vera reads a proposal for a brand-new runbook and decides it does not belong
// as a runbook of its own: a reject needs a reason, and a merge re-aims it at a
// runbook that exists. The walk checks the controls and the refusal, and rejects
// with a note inside a scoped copy of the world.
export default {
  family: 'runbooks', log: 'reviewer/reject-merge', kind: 'journey', persona: P.vera, scenario: { scope: 'default' }, writes: true, identity: 'clone',
  goal: 'Open a proposal for a new runbook, see Reject and Merge proposal, and reject it with a reason',
  fields: { surface: 'reject or merge a proposal', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks/proposals/prop-flaky-quarantine-check', 'A proposal for a new runbook offers Reject and a merge into an existing one',
      ['Merge proposal'], { expectConsole: DIFF_KEY_WARNING, expect: { visible: [{ testId: 'proposal-merge' }, { testId: 'proposal-card' }] } }),
    { do: 'api', method: 'POST', url: '/api/runbooks/proposals/prop-flaky-quarantine-check/reject', body: {}, writes: true, proves: 'gating',
      name: 'A reject with no note is refused', expect: { status: 400 } },
    { do: 'api', method: 'POST', url: '/api/runbooks/proposals/prop-flaky-quarantine-check/reject', body: { note: 'The flaky-test runbook already covers rerunning before quarantine; add the checklist there.' }, writes: true, proves: 'gating',
      name: 'Rejecting with a reason closes the proposal', expect: { status: 200 } },
    page('/iq/runbooks/proposals/prop-flaky-quarantine-check', 'The proposal now shows who rejected it and why',
      [/Rejected/, 'flaky-test runbook already covers'], { expectConsole: DIFF_KEY_WARNING, expect: { visible: [{ testId: 'proposal-decided' }] } }),
  ],
} satisfies JourneyMap;
