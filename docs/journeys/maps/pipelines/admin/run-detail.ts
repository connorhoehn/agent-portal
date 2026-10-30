import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'run-detail');
export default {
  family: 'pipelines', log: 'admin/run-detail', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'run-detail'),
  fields: { surface: 'run-detail', pages: PAGES['run-detail'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['run-detail']('admin'),
} satisfies JourneyMap;
