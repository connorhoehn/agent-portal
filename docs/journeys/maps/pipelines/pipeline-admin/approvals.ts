import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'approvals');
export default {
  family: 'pipelines', log: 'pipeline-admin/approvals', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'approvals'),
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['approvals']('pipeline-admin'),
} satisfies JourneyMap;
