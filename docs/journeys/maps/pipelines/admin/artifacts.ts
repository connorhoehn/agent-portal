import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'artifacts');
export default {
  family: 'pipelines', log: 'admin/artifacts', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'artifacts'),
  fields: { surface: 'artifacts', pages: PAGES['artifacts'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['artifacts']('admin'),
} satisfies JourneyMap;
