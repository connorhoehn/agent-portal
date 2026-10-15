import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'distillation', log: 'member/knowledge', kind: 'surface', persona: PERSONA['member'], scenario: 'shared',
  goal: GOALS['member']['knowledge'],
  fields: { surface: 'knowledge', pages: PAGES['knowledge'] },
  steps: SURFACES['knowledge']('member'),
} satisfies JourneyMap;
