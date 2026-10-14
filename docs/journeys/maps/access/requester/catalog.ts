import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA, PREVIEW } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/catalog', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared', readOnlyPosts: PREVIEW,
  goal: GOALS['requester']['catalog'],
  fields: { surface: 'catalog', pages: PAGES['catalog'] },
  steps: SURFACES['catalog']('requester'),
} satisfies JourneyMap;
