import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'runs');
export default {
  family: 'pipelines', log: 'admin/runs', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'runs'),
  fields: { surface: 'runs', pages: PAGES['runs'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runs']('admin'),
} satisfies JourneyMap;
