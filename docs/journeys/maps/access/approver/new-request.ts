import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA, PREVIEW } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/new-request', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared', readOnlyPosts: PREVIEW,
  goal: GOALS['approver']['new-request'],
  fields: { surface: 'new-request', pages: PAGES['new-request'] },
  steps: SURFACES['new-request']('approver'),
} satisfies JourneyMap;
