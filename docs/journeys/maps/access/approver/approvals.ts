import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/approvals', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['approvals'],
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  steps: SURFACES['approvals']('approver'),
} satisfies JourneyMap;
