import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'distillation', log: 'org-leader/activity', kind: 'surface', persona: PERSONA['org-leader'], scenario: 'shared',
  goal: GOALS['org-leader']['activity'],
  fields: { surface: 'activity', pages: PAGES['activity'] },
  steps: SURFACES['activity']('org-leader'),
} satisfies JourneyMap;
