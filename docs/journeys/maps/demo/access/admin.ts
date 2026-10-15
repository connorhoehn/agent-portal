import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, seen, fact } from '../_shared.ts';

// Access, act three: Priya governs. The quarterly review has a deadline and
// people's roles in words; the policy matrix has fired at least once; the
// audit reads as sentences.
export default {
  family: 'demo', log: 'access/admin', kind: 'story', persona: P.priya, scenario: 'shared',
  goal: 'Show a peer the certification campaign, a policy that caught something, and an audit trail a person can read',
  fields: { surface: 'the governance story', pages: 'portal/src/pages/access' },
  steps: [
    fact('/access/reviews/rev-0001', 'The review campaign has a deadline and roles in words', ['Q4 SME certification', /Closes|Due/i], [/· sme\b/]),
    fact('/access/policies', 'Policies name roles in words, who last changed them, and one has caught a request', [/SME/, 'Priya Venkataraman'], [/\bsme · Work\b/, /\borg-leader · Work\b/]),
    { do: 'navigate', url: '/access/audit', name: 'The audit trail reads as sentences, with no internal ids or duplicate rows', proves: 'cross-links', audit: true,
      expect: { visible: ['Rhea Castellanos'].map(seen), noText: [/\bsod-\d{3}\b/, /\bdlg-\d{4}\b/, /\bdraft → submitted\b/] } },
  ],
} satisfies JourneyMap;
