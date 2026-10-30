import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/channels', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER['community-admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('community-admin', 'channels'),
  fields: { surface: 'channels', pages: PAGES['channels'] },
  claims: claims('channels'),
  steps: SURFACES['channels']('community-admin'),
} satisfies JourneyMap;
