import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'distillation', log: 'org-leader/review', kind: 'surface', persona: PERSONA['org-leader'], scenario: 'shared',
  goal: GOALS['org-leader']['review'],
  fields: { surface: 'review', pages: PAGES['review'] },
  steps: SURFACES['review']('org-leader'),
} satisfies JourneyMap;
