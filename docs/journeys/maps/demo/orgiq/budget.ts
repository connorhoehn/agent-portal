import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, seen, fact } from '../_shared.ts';

// Work, the money side: Mia allocated Auth Migration's budget and granted its
// sprint envelope; spend comes from the runs a peer just saw.
export default {
  family: 'demo', log: 'orgiq/budget', kind: 'story', persona: P.mia, scenario: 'shared',
  goal: 'Show a peer that the budget Mia allocated is being spent by the agent runs on Auth Migration',
  fields: { surface: 'the program budget story', pages: 'portal/src/pages/admin/budgets, portal/src/pages/project-detail' },
  steps: [
    fact('/admin/budgets', 'Budgets list Auth Migration with spend against its allocation and the sprint grant Mia made',
      ['Auth Migration', 'Mia Singh', /\$\d/], [/\$0\.00 of/]),
    fact('/iq/projects/p-auth-migration', 'The initiative overview shows the sprint and the spend against its allocation',
      ['Auth Migration', /Sprint \d{1,2}\b/, /\$\d/], [/Sprint (?:4\d|9\d)\b/]),
    { do: 'navigate', url: '/iq/projects?lens=sprints', name: 'The sprints lens shows each sprint with work in it', proves: 'cross-links', audit: false, auditReason: 'a content walk: the layout judges measure this page', expect: { visible: ['Auth Migration'].map(seen), noText: [/\b0 items\b/] } },
  ],
} satisfies JourneyMap;
