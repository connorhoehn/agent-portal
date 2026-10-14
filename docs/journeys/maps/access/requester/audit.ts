import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/audit', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['audit'],
  fields: { surface: 'audit', pages: PAGES['audit'] },
  steps: SURFACES['audit']('requester'),
} satisfies JourneyMap;
