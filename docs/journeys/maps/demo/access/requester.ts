import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, fact, follow, link } from '../_shared.ts';

// Access, act one: Rhea asks for SME in Work. A clone of Rhea must see Rhea's
// requests — a demo cannot depend on the one seed user id the rows are keyed by.
export default {
  family: 'demo', log: 'access/requester', kind: 'story', persona: P.rhea, scenario: 'shared',
  goal: 'Show a peer Rhea’s open request, who it waits on and why she asked',
  fields: { surface: 'the requester story', pages: 'portal/src/pages/access' },
  steps: [
    fact('/access/requests', 'Rhea’s requests are listed, the open one first', ['SME in Work', 'Omar Haddad'], [/You have not requested any access yet/]),
    follow(link(/SME in Work|req-0001/), /^\/access\/requests\/req-0001/, 'The open request opens its record', ['Omar Haddad', /SSO cutover/i]),
  ],
} satisfies JourneyMap;
