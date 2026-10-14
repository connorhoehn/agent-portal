import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/request', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['request'],
  fields: { surface: 'request', pages: PAGES['request'] },
  steps: SURFACES['request']('approver'),
} satisfies JourneyMap;
