import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page, DIFF_KEY_WARNING } from '../_shared.ts';

// Nora DaSilva sent an agent at the tenant cutover; the run failed at the flip
// and wrote down what would have prevented it. The proposal says which run, what
// it changed and why, with the diff against the version the run was given.
export default {
  family: 'runbooks', log: 'author/from-run', kind: 'journey', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: 'Find the edit a failed run proposed to the cutover runbook and read what it changes and why',
  fields: { surface: 'a run’s proposal', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks/proposals', 'Proposals lists the open edits, the cutover one among them',
      ['Proposals', 'SAML to Cognito migration']),
    { do: 'click', target: { role: 'button', name: /SAML to Cognito migration/ }, audit: true, proves: 'shows', expectConsole: DIFF_KEY_WARNING,
      name: 'The cutover proposal opens beside the list, naming the run and why',
      expect: { url: /^\/iq\/runbooks\/proposals\/prop-tenant-cutover-callback/, visible: [{ testId: 'proposal-review' }, { testId: 'proposal-diff' }], text: [/hosted-UI redirect/], noText: [/\bundefined\b/] } },
    { do: 'navigate', url: '/iq/runbooks/proposals/prop-tenant-cutover-callback', audit: true, proves: 'gating', expectConsole: DIFF_KEY_WARNING,
      name: 'An SME who is not its owner or steward reads the proposal and is told what only the owner decides',
      expect: { visible: [{ testId: 'proposal-card' }], text: [/Callback|callback/] } },
  ],
} satisfies JourneyMap;
