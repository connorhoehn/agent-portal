import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/request', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['request'],
  fields: { surface: 'request', pages: PAGES['request'] },
  steps: SURFACES['request']('access-admin'),
} satisfies JourneyMap;
