import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/approvals', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['approvals'],
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  steps: SURFACES['approvals']('access-admin'),
} satisfies JourneyMap;
