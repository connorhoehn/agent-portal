import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'agents');
export default {
  family: 'pipelines', log: 'pipeline-admin/agents', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'agents'),
  fields: { surface: 'agents', pages: PAGES['agents'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['agents']('pipeline-admin'),
} satisfies JourneyMap;
