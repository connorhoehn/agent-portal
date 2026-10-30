import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'agents');
export default {
  family: 'pipelines', log: 'operator/agents', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'agents'),
  fields: { surface: 'agents', pages: PAGES['agents'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['agents']('operator'),
} satisfies JourneyMap;
