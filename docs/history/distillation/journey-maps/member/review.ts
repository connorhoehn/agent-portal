import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'distillation', log: 'member/review', kind: 'surface', persona: PERSONA['member'], scenario: 'shared',
  goal: GOALS['member']['review'],
  fields: { surface: 'review', pages: PAGES['review'] },
  steps: SURFACES['review']('member'),
} satisfies JourneyMap;
