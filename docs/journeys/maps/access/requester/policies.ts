import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/policies', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['policies'],
  fields: { surface: 'policies', pages: PAGES['policies'] },
  steps: SURFACES['policies']('requester'),
} satisfies JourneyMap;
