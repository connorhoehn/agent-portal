import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/dms', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER['admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('admin', 'dms'),
  fields: { surface: 'dms', pages: PAGES['dms'] },
  claims: claims('dms'),
  steps: SURFACES['dms']('admin'),
} satisfies JourneyMap;
