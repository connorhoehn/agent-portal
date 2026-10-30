import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'runbooks');
export default {
  family: 'pipelines', log: 'admin/runbooks', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'runbooks'),
  fields: { surface: 'runbooks', pages: PAGES['runbooks'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runbooks']('admin'),
} satisfies JourneyMap;
