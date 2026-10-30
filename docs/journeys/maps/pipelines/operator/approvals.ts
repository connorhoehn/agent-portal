import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'approvals');
export default {
  family: 'pipelines', log: 'operator/approvals', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'approvals'),
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['approvals']('operator'),
} satisfies JourneyMap;
