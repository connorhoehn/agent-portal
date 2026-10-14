import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA, PREVIEW } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/new-request', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared', readOnlyPosts: PREVIEW,
  goal: GOALS['access-admin']['new-request'],
  fields: { surface: 'new-request', pages: PAGES['new-request'] },
  steps: SURFACES['new-request']('access-admin'),
} satisfies JourneyMap;
