import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES } from '../_shared.ts';

// What a box is handed, and what it may not do, seen from the routes it calls.
// A box reads its brief with its fleet envelope and its run token; a person's
// session reads the preview. This walk stands in the person's seat: the preview
// is the same assembler, a run that was never given a brief is a 404 and not an
// empty answer, and reporting on a runbook (a box's `lab applied`) is refused to a
// person.
export default {
  family: 'runbooks', log: 'box/brief', kind: 'journey', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: 'Check the routes a box calls: the brief assembles, a missing brief is a 404, and only a box may report on a runbook',
  fields: { surface: 'the brief routes a box calls', pages: 'middleware/src/routes/session-briefs.ts, middleware/src/routes/runbooks.ts' + (SURFACE_PAGES ? '' : '') },
  steps: [
    { do: 'navigate', url: '/iq/runbooks', audit: true, proves: 'shows', name: 'Open the runbook library the routes sit behind', expect: { text: ['Runbooks'] } },
    { do: 'api', url: '/api/work-items/wi-auth-e2-s2/brief-preview', proves: 'shows', name: 'The brief a run would be given assembles for the cutover story', expect: { status: 200 } },
    { do: 'api', url: '/api/runs/sess-auth-06/brief', proves: 'gating', name: 'A run with no frozen brief answers 404', expect: { status: 404 } },
    { do: 'api', method: 'POST', url: '/api/runbooks/rb-tenant-cutover/applications', body: { run_ref: 'sess-auth-06', version: 1, outcome: 'followed' },
      refusal: 'applications are reported by a box with its service envelope; a person’s session carries none, so the route refuses before reading the body', proves: 'gating',
      name: 'Reporting on a runbook is refused to a person', expect: { status: [401, 403] } },
  ],
} satisfies JourneyMap;
