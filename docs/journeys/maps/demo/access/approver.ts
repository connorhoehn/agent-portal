import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, seen, fact } from '../_shared.ts';

// Access, act two: Omar decides his report's request; the steward step after
// him is a named person who can decide, not an automatic escalation.
export default {
  family: 'demo', log: 'access/approver', kind: 'story', persona: P.omar, scenario: 'shared',
  goal: 'Show a peer the approval a manager owes and the chain that follows it',
  fields: { surface: 'the approver story', pages: 'portal/src/pages/access' },
  steps: [
    fact('/access/approvals', 'Omar’s inbox holds Rhea’s request', ['Rhea Castellanos', 'SME in Work']),
    { do: 'navigate', url: '/access/requests/req-0001', name: 'The chain names each approver once, and the steward is a person who can decide', proves: 'cross-links', audit: false, auditReason: 'a content walk: the layout judges measure this page',
      expect: { visible: ['Omar Haddad', 'Rhea Castellanos'].map(seen), noText: [/Omar Haddad, Omar Haddad/, /Escalated to the access admins/, /access:req:req-/, /\bsod-\d{3}:/] } },
  ],
} satisfies JourneyMap;
