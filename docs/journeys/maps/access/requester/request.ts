import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/request', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['request'],
  fields: { surface: 'request', pages: PAGES['request'] },
  steps: SURFACES['request']('requester'),
} satisfies JourneyMap;
