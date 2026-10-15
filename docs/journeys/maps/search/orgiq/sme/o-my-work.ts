import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, ask, open, result, link, searchUrl } from '../../_shared.ts';

// Catalog o-my-work (sme): "what am I working on" — "me" binds to the clone's persona through lib/record-owner.ts (U6).
export default {
  family: 'search', log: 'orgiq/sme-o-my-work', kind: 'intent', persona: P.nora, scenario: 'shared', identity: 'clone',
  goal: "See my own open work from the Work search, as a clone of Nora",
  fields: { surface: "Work search: implicit \"me\"", pages: "portal/src/pages/search, middleware/src/providers/search.ts, middleware/src/lib/search-index" },
  steps: [
    ask(searchUrl('what am I working on'), 'Nora\u2019s open items lead the results (assigned to the signed-in person)', ['Cost-aware telemetry']),
    open(result('Cost-aware telemetry'), /^\/iq\/projects\/p-observability\?tab=work&item=wi-obs-e3/, 'The item opens on its initiative\u2019s work tab'),
  ],
} satisfies JourneyMap;
