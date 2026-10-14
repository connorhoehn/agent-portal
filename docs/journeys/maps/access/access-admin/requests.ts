import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/requests', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['requests'],
  fields: { surface: 'requests', pages: PAGES['requests'] },
  steps: SURFACES['requests']('access-admin'),
} satisfies JourneyMap;
