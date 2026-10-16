import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, RUNBOOK, SURFACE_PAGES } from '../_shared.ts';

// Before sending an agent at a work item, Nora DaSilva looks at what it would be
// told: the work, the initiative, the decisions that bind it, and (R8) one line
// saying the org's established skills are installed on the box — procedures
// reach a box only as skills, never as text in the brief.
export default {
  family: 'runbooks', log: 'consumer/brief-preview', kind: 'journey', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: 'Open a work item, preview the brief a run would be given and see that it points at the installed skills',
  fields: { surface: 'brief preview on a work item', pages: SURFACE_PAGES + ', portal/src/pages/project-detail' },
  steps: [
    { do: 'navigate', url: '/iq/projects/p-auth-migration?item=wi-auth-e2-s2', audit: true, proves: 'shows',
      name: 'The blocked cutover story is open with its Brief preview',
      expect: { visible: [{ testId: 'work-item-brief-preview' }], text: ['Tenant-by-tenant cutover runbook with rollback'] } },
    { do: 'click', target: { text: 'Brief preview' }, audit: true, proves: 'shows',
      name: 'The preview carries the work and one line pointing at the org’s installed skills, and says it is a preview, not a run’s brief',
      expect: { text: [/A preview, not a run/, /established skills are installed in/], noText: [new RegExp(RUNBOOK.cutover.title)], visible: [{ testId: 'brief-document' }, { testId: 'brief-sections' }] } },
    { do: 'api', url: '/api/work-items/wi-auth-e2-s2/brief-preview', proves: 'gating',
      name: 'The same preview over the API needs only the brief permission an SME holds', expect: { status: 200 } },
  ],
} satisfies JourneyMap;
