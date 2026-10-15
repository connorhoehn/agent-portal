import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page } from '../_shared.ts';

// After a run starts, its brief is frozen: the exact text the box received. The
// Briefs page lists them; a run with none says so instead of showing an empty
// tab. (The seeded runs predate briefs, so on the default world the list is
// empty and a deep link to a run reads as "no brief was frozen".)
export default {
  family: 'runbooks', log: 'consumer/run-brief', kind: 'journey', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: 'Open the Briefs page, and a run’s brief link, and see an honest answer when the run was given none',
  fields: { surface: 'a run’s frozen brief', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks/briefs', 'Briefs says what it is for and that no run has been given one yet',
      ['Briefs', /No briefs yet|Choose a brief/]),
    { do: 'navigate', url: '/iq/runbooks/briefs/sess-auth-06', audit: true, proves: 'gating', expectConsole: /404|Not Found|NO_BRIEF/i,
      name: 'A run that was never given a brief says so rather than showing an empty tab',
      expect: { text: ['No brief was frozen for this run'], noText: [/\bundefined\b/] } },
  ],
} satisfies JourneyMap;
