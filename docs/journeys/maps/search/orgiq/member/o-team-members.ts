import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, ask, open, result, link, searchUrl } from '../../_shared.ts';

// Catalog o-team-members (member): "who is on the platform team" — the team entity's members (U4).
export default {
  family: 'search', log: 'orgiq/member-o-team-members', kind: 'intent', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: "Find who is on the platform team from the Work search",
  fields: { surface: "Work search: team members", pages: "portal/src/pages/search, middleware/src/providers/search.ts, middleware/src/lib/search-index" },
  steps: [
    ask(searchUrl('who is on the platform team'), 'Platform Engineering\u2019s members lead the results', [/Arjun Shah|Caleb Turner|Theo Chang|Vera Green|Nora DaSilva/]),
    open(result(/Arjun Shah|Caleb Turner|Eli Garcia|Grace Singh/), /selection=person(?:%3A|:)p-\d{3}/, 'A member opens their profile in Connections'),
  ],
} satisfies JourneyMap;
