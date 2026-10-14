import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/policies', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['policies'],
  fields: { surface: 'policies', pages: PAGES['policies'] },
  steps: SURFACES['policies']('approver'),
} satisfies JourneyMap;
