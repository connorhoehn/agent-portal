import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'agents');
export default {
  family: 'pipelines', log: 'admin/agents', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'agents'),
  fields: { surface: 'agents', pages: PAGES['agents'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['agents']('admin'),
} satisfies JourneyMap;
