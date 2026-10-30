import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, inboundClaims, ISOLATION_PAGES } from '../_shared.ts';

// The cookie-less fallback identity (dev only): no sign-in, so it walks as itself (identity: 'demo').
export default {
  family: 'social', log: 'isolation/demo-user', kind: 'isolation-inbound', scenario: 'shared', identity: 'demo',
  persona: { user: 'demo-user', name: 'Demo User', tenant: 'orgiq', role: 'member' },
  goal: 'The cookie-less demo identity holds no social grant: no Social tile, link, route or API, and nothing from Social in its bell',
  fields: { pages: ISOLATION_PAGES },
  claims: inboundClaims(false),
  steps: inbound('/iq/projects', false, ['/social', '/pipelines', '/access']),
} satisfies JourneyMap;
