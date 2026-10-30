import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/dms', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER['community-admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('community-admin', 'dms'),
  fields: { surface: 'dms', pages: PAGES['dms'] },
  claims: claims('dms'),
  steps: SURFACES['dms']('community-admin'),
} satisfies JourneyMap;
