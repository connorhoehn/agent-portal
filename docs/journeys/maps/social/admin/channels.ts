import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/channels', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER['admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('admin', 'channels'),
  fields: { surface: 'channels', pages: PAGES['channels'] },
  claims: claims('channels'),
  steps: SURFACES['channels']('admin'),
} satisfies JourneyMap;
