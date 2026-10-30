import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'approvals');
export default {
  family: 'pipelines', log: 'author/approvals', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'approvals'),
  fields: { surface: 'approvals', pages: PAGES['approvals'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['approvals']('author'),
} satisfies JourneyMap;
