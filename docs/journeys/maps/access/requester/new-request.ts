import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA, PREVIEW } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/new-request', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared', readOnlyPosts: PREVIEW,
  goal: GOALS['requester']['new-request'],
  fields: { surface: 'new-request', pages: PAGES['new-request'] },
  steps: SURFACES['new-request']('requester'),
} satisfies JourneyMap;
