import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/recordings', kind: 'surface', persona: PERSONA['moderator'], scenario: 'shared',
  goal: goal('moderator', 'recordings'),
  fields: { surface: 'recordings', pages: PAGES['recordings'] },
  claims: claims('recordings'),
  steps: SURFACES['recordings']('moderator'),
} satisfies JourneyMap;
