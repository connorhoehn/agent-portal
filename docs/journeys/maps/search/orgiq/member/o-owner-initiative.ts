import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, ask, open, result, link, searchUrl } from '../../_shared.ts';

// Catalog o-owner-initiative (member): "who owns the auth migration" — Vera Green.
export default {
  family: 'search', log: 'orgiq/member-o-owner-initiative', kind: 'intent', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: "Find who owns Auth Migration from the Work search",
  fields: { surface: "Work search: an initiative's people", pages: "portal/src/pages/search, middleware/src/providers/search.ts, middleware/src/lib/search-index" },
  steps: [
    ask(searchUrl('who owns the auth migration'), 'The owner leads the results, with the initiative beside her', ['Vera Green', 'Auth Migration']),
    open(result('Vera Green'), /selection=person(?:%3A|:)p-002/, 'The owner opens her profile in Connections'),
  ],
} satisfies JourneyMap;
