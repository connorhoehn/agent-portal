import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/requests', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['requests'],
  fields: { surface: 'requests', pages: PAGES['requests'] },
  steps: SURFACES['requests']('approver'),
} satisfies JourneyMap;
