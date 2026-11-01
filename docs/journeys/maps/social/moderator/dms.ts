import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

// Opening a DM advances its read receipt. The primary clone writes only in its
// scoped world; the presence peer is explicitly read-only. Isolation is proved
// in middleware/src/routes/__tests__/social-clone-dms.test.ts.
export default {
  family: 'social', log: 'moderator/dms', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: { scope: 'default' }, writes: true,
  goal: goal('moderator', 'dms'),
  fields: { surface: 'dms', pages: PAGES['dms'] },
  claims: claims('dms'),
  steps: SURFACES['dms']('moderator'),
} satisfies JourneyMap;
