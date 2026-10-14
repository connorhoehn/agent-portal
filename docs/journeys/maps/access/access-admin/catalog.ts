import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA, PREVIEW } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/catalog', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared', readOnlyPosts: PREVIEW,
  goal: GOALS['access-admin']['catalog'],
  fields: { surface: 'catalog', pages: PAGES['catalog'] },
  steps: SURFACES['catalog']('access-admin'),
} satisfies JourneyMap;
