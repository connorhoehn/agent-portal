import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

// The cookie-less demo identity (dev only) as it lands: orgiq/member, never switched (a switch bumps the one shared
// demo-user epoch). The chooser keeps offering it every workspace by design, so its tile line says yes; its session
// is not in the assessment tenant, so the routes still send it away and the API still answers 403.
export default {
  family: 'assessment', log: 'isolation/demo-user', kind: 'isolation-inbound', scenario: 'shared', identity: 'demo',
  persona: { user: 'demo-user', name: 'Demo User (cookie-less, dev only)', tenant: 'orgiq', role: 'member' },
  goal: 'The cookie-less demo identity, outside the assessment tenant, reaches no assessment route or API even though the dev chooser offers it the workspace',
  fields: { pages: ISOLATION_PAGES },
  claims: { ...INBOUND_CLAIMS, 'assessment-tile-visible': 'yes, by design for the dev-only cookie-less identity' },
  steps: inbound('/iq/projects', { tileByDesign: true }),
} satisfies JourneyMap;
