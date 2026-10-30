import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/calls', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER['admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('admin', 'calls'),
  fields: { surface: 'calls', pages: PAGES['calls'] },
  claims: claims('calls'),
  steps: SURFACES['calls']('admin'),
} satisfies JourneyMap;
