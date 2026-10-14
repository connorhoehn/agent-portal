import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/requests', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['requests'],
  fields: { surface: 'requests', pages: PAGES['requests'] },
  steps: SURFACES['requests']('requester'),
} satisfies JourneyMap;
