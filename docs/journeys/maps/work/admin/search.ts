// The cross-tenant admin's search walk: hr-admin's steps (the same people, initiatives and decisions are in reach),
// signed in as a clone of u-operator.
import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { surfaceMap } from '../_shared.ts';

const base = surfaceMap('hr-admin', 'search');
export default {
  ...base, log: 'admin/search',
  persona: { user: 'u-operator', name: 'Platform Operator', tenant: 'orgiq', role: 'admin' },
  goal: base.goal.replace(/^[^:]+:/, 'Platform Operator:'),
} satisfies JourneyMap;
