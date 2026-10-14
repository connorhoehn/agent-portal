import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'distillation', log: 'org-leader/knowledge', kind: 'surface', persona: PERSONA['org-leader'], scenario: 'shared',
  goal: GOALS['org-leader']['knowledge'],
  fields: { surface: 'knowledge', pages: PAGES['knowledge'] },
  steps: SURFACES['knowledge']('org-leader'),
} satisfies JourneyMap;
