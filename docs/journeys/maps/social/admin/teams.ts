import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/teams', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER['admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('admin', 'teams'),
  fields: { surface: 'teams', pages: PAGES['teams'] },
  claims: claims('teams'),
  steps: SURFACES['teams']('admin'),
} satisfies JourneyMap;
