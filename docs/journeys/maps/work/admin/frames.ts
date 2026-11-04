// The cross-tenant admin's frames walk: the same core pages as hr-admin (the same rail, landing and grants in Work),
// signed in as a clone of u-operator. See admin/refusals.ts for what was measured.
import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { framesMap } from '../_shared.ts';

const base = framesMap('hr-admin');
export default {
  ...base, log: 'admin/frames',
  persona: { user: 'u-operator', name: 'Platform Operator', tenant: 'orgiq', role: 'admin' },
  goal: 'Platform Operator: the core pages at 1440 and 900 wide, light and dark: nothing clipped, no horizontal scroll, the audit clean in both themes',
} satisfies JourneyMap;
