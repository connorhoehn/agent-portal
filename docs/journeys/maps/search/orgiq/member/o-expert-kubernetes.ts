import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, ask, open, result, link, searchUrl } from '../../_shared.ts';

// Catalog o-expert-kubernetes (member): "who knows Kubernetes" — the people with the skill, never a canned leaderboard.
export default {
  family: 'search', log: 'orgiq/member-o-expert-kubernetes', kind: 'intent', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: "Find who knows Kubernetes from the Work search",
  fields: { surface: "Work search: people by skill", pages: "portal/src/pages/search, middleware/src/providers/search.ts, middleware/src/lib/search-index" },
  steps: [
    ask(searchUrl('who knows Kubernetes'), 'The question lists people whose skills include Kubernetes', [/Grace Singh|Hugo Lee|Arjun Shah|Marcus Müller|Henry Hassan|Sarah Thompson/]),
    open(result(/Grace Singh|Hugo Lee|Arjun Shah|Marcus Müller|Henry Hassan|Sarah Thompson/), /tab=connections.*selection=person(?:%3A|:)p-\d{3}/, 'The first expert opens their profile in Connections'),
  ],
} satisfies JourneyMap;
