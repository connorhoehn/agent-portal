import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page } from '../_shared.ts';

// After a run starts, its brief is frozen: the exact text the box received. The
// Briefs page lists them. The seeded Auth Migration firing of auth-dep-watch
// (job-auth-maint-1) has one, with the CSRF-gate runbook it was handed; the
// older seeded sessions predate briefs, so a deep link to one reads "no brief
// was frozen" instead of showing an empty tab.
export default {
  family: 'runbooks', log: 'consumer/run-brief', kind: 'journey', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: 'Open the Briefs page and a run’s frozen brief, and see an honest answer when a run was given none',
  fields: { surface: 'a run’s frozen brief', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks/briefs', 'Briefs lists the frozen brief of the Auth Migration dependency-watch run, by name',
      ['Briefs', 'Auth Migration', /auth-dep-watch run/]),
    page('/iq/runbooks/briefs/job-auth-maint-1', 'The run’s brief shows its sha, the project and the runbook it was handed, and the exact text the box received',
      ['The exact text the box received', 'Auth Migration', 'Get an auth-service pull request through the CSRF check'],
      { expect: { visible: [{ testId: 'brief-document' }, { testId: 'brief-sections' }, { testId: 'brief-markdown' }] } }),
    { do: 'navigate', url: '/iq/runbooks/briefs/sess-auth-06', audit: true, proves: 'gating', expectConsole: /404|Not Found|NO_BRIEF/i,
      name: 'A run that was never given a brief says so rather than showing an empty tab',
      expect: { text: ['No brief was frozen for this run'], noText: [/\bundefined\b/] } },
  ],
} satisfies JourneyMap;
