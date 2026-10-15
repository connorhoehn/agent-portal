import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, seen, fact } from '../_shared.ts';

// Pipelines: Kofi operates the definitions Ines authored. The run ledger has
// real outcomes (one failure with a cause); the approval queue asks about work
// that is actually pending; the bots that ran today are enabled.
export default {
  family: 'demo', log: 'pipelines/story', kind: 'story', persona: P.kofi, scenario: 'shared',
  goal: 'Show a peer how an operator watches runs, decides a waiting approval and traces a failure to its definition and owner',
  fields: { surface: 'the operator story', pages: 'portal/src/pages/pipelines' },
  steps: [
    fact('/pipelines/runs', 'The run ledger has varied outcomes, people who launched runs, and work items by name',
      [/\bfailed\b/i, /Ines Moreau|Kofi Mensah/], [/scheduled maintenance — completed/, /marketplace work wi-/]),
    fact('/pipelines/approvals', 'The waiting approvals name the work they are about, in words',
      [/Approve|Waiting/i], [/consult:con-mock/, /escalated to a release manager/]),
    fact('/pipelines/definitions', 'Definitions are owned by the pipelines cast and titled in words',
      ['Ines Moreau'], [/\bbot:[0-9a-f]{8}/, /orgiq-assessment-scorer/, /^classify-transcript$/m]),
    { do: 'navigate', url: '/pipelines/bots', name: 'The bots that ran today are running, not parked', proves: 'cross-links', audit: false, auditReason: 'a content walk: the layout judges measure this page', expect: { visible: [/Enabled|Active|Running/i].map(seen), noText: [/awaiting repo provisioning/] } },
  ],
} satisfies JourneyMap;
