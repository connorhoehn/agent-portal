import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/teams', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER['community-admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('community-admin', 'teams'),
  fields: { surface: 'teams', pages: PAGES['teams'] },
  claims: claims('teams'),
  steps: SURFACES['teams']('community-admin'),
} satisfies JourneyMap;
