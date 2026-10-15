import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'distillation', log: 'member/activity', kind: 'surface', persona: PERSONA['member'], scenario: 'shared',
  goal: GOALS['member']['activity'],
  fields: { surface: 'activity', pages: PAGES['activity'] },
  steps: SURFACES['activity']('member'),
} satisfies JourneyMap;
