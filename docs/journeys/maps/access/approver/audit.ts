import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/audit', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['audit'],
  fields: { surface: 'audit', pages: PAGES['audit'] },
  steps: SURFACES['audit']('approver'),
} satisfies JourneyMap;
