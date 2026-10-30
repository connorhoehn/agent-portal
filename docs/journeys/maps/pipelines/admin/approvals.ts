import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'approvals');
export default {
  family: 'pipelines', log: 'admin/approvals', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'approvals'),
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['approvals']('admin'),
} satisfies JourneyMap;
