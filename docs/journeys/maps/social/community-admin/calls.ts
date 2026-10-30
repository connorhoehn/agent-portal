import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/calls', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER['community-admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('community-admin', 'calls'),
  fields: { surface: 'calls', pages: PAGES['calls'] },
  claims: claims('calls'),
  steps: SURFACES['calls']('community-admin'),
} satisfies JourneyMap;
