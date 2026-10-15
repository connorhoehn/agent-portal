import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, fact, follow } from '../_shared.ts';

// Assessment: Jonas reviews Northstar Payments. The team claimed level 5 on CI
// but the evidence shows 2; a not-applicable request waits for his decision;
// a failed ingestion run on another team has a follow-up someone owns.
export default {
  family: 'demo', log: 'assessment/story', kind: 'story', persona: P.jonas, scenario: 'shared',
  goal: 'Show a peer how a lead assessor reviews one team’s maturity scorecard and the decisions waiting on him',
  fields: { surface: 'the Northstar Payments review', pages: 'portal/src/pages/assessment' },
  steps: [
    fact('/assessment/teams', 'The teams list names each team’s lead assessor from the cast',
      ['Northstar Payments', 'Jonas Lindqvist']),
    follow({ text: 'Northstar Payments', exact: true, within: { css: 'main tbody' } }, /^\/assessment\/teams\/TEAM-001/, 'The team opens its scorecard from its row', ['Northstar Payments']),
    fact('/assessment/teams/TEAM-001', 'The scorecard is varied, cites real evidence and names its assessors',
      ['Northstar Payments', /Asha Nair|Jonas Lindqvist/], [/orgiq-assessment-scorer/, /\bLeading\b/, /we pointed the assessor at a written runbook/]),
    fact('/assessment/feedback', 'Feedback holds a few specific asks, including the not-applicable request Jonas decides',
      ['Northstar Payments', /not applicable|N\/A/i], [/Could you share the dashboard, pipeline run, or export backing your/]),
    fact('/assessment/runs', 'A failed run says why, and its team is named',
      [/\bfailed\b/i, /Data Platform|Payments|Checkout|Fraud/]),
    fact('/assessment/reports', 'The report rolls up the same scores the scorecard shows', ['Northstar Payments']),
  ],
} satisfies JourneyMap;
