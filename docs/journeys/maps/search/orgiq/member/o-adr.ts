import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, ask, open, result, link, searchUrl } from '../../_shared.ts';

// Catalog o-adr (member): "Aurora Neptune decision" — d-aurora.
export default {
  family: 'search', log: 'orgiq/member-o-adr', kind: 'intent', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: "Find the Aurora-over-Neptune decision from the Work search",
  fields: { surface: "Work search: decisions", pages: "portal/src/pages/search, middleware/src/providers/search.ts, middleware/src/lib/search-index" },
  steps: [
    ask(searchUrl('Aurora Neptune decision'), 'The decision is the first result', ['Adopt Aurora over Neptune']),
    open(result('Adopt Aurora over Neptune'), /^\/iq\/decisions\/d-aurora/, 'The decision opens its record page', ['Adopt Aurora over Neptune']),
  ],
} satisfies JourneyMap;
