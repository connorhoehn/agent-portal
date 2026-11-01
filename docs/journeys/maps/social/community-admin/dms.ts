import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

// Opening a DM advances its read receipt. The primary clone writes only in its
// scoped world; the presence peer is explicitly read-only. Isolation is proved
// in middleware/src/routes/__tests__/social-clone-dms.test.ts.
export default {
  family: 'social', log: 'community-admin/dms', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER['community-admin'] }, identityReason: PEER_REASON, scenario: { scope: 'default' }, writes: true,
  goal: goal('community-admin', 'dms'),
  fields: { surface: 'dms', pages: PAGES['dms'] },
  claims: claims('dms'),
  steps: SURFACES['dms']('community-admin'),
} satisfies JourneyMap;
