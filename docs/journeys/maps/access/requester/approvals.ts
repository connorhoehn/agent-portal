import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/approvals', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['approvals'],
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  steps: SURFACES['approvals']('requester'),
} satisfies JourneyMap;
