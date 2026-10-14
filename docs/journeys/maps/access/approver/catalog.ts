import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA, PREVIEW } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/catalog', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared', readOnlyPosts: PREVIEW,
  goal: GOALS['approver']['catalog'],
  fields: { surface: 'catalog', pages: PAGES['catalog'] },
  steps: SURFACES['catalog']('approver'),
} satisfies JourneyMap;
