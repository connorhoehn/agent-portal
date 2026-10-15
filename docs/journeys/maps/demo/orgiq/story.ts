import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, fact, follow, link } from '../_shared.ts';

// Work: Auth Migration. Vera Green owns it; the legacy SSO decommission is
// blocked on the escalated decision "Cutover order for legacy SSO tenants",
// which Sienna Garcia (the release manager) must make; #auth-migration talks
// about the same blocker; agents worked its items and one run failed for a
// reason someone discussed.
export default {
  family: 'demo', log: 'orgiq/story', kind: 'story', persona: P.vera, scenario: 'shared',
  goal: 'Show a peer what Auth Migration is, who runs it, what it is waiting on and what the agents did for it, in five minutes',
  fields: { surface: 'the Auth Migration story', pages: 'portal/src/pages/project-detail, portal/src/pages/decisions, portal/src/pages/designs, portal/src/pages/runs' },
  steps: [
    fact('/iq/projects/p-auth-migration', 'The initiative names its owner, its SMEs and the decision it is waiting on',
      ['Auth Migration', 'Vera Green', 'Nora DaSilva', 'Cutover order for legacy SSO tenants']),
    follow(link('Cutover order for legacy SSO tenants'), /^\/iq\/decisions\/d-cognito-cutover/, 'The waiting decision opens its record from the initiative', ['Escalated', 'Sienna Garcia']),
    fact('/iq/projects/p-auth-migration?item=wi-auth-e2-s2', 'The blocked runbook story says what blocks it and who can unblock it',
      ['Tenant-by-tenant cutover runbook', /blocked/i, 'Cutover order for legacy SSO tenants', 'Sienna Garcia'], [/\b(?:Jan|Feb|Mar|Apr|May|Jun) \d{1,2}\b/]),
    fact('/iq/designs/des-auth-rotation', 'The design review is signed off by people on the initiative, not by a bot',
      ['Auth Migration', 'Vera Green'], [/auth-dep-watch/]),
    fact('/iq/communication/channels/auth-migration?view=chat', 'The initiative channel discusses the same blocker the board shows',
      [/cutover/i, 'Vera Green', 'Sienna Garcia'], [/Cutover is done/]),
    fact('/iq/runs', 'Agent runs read as real work: varied outcomes, one failure with a cause',
      [/\bfailed\b/i, /Auth Migration/], [/scheduled maintenance — completed/]),
  ],
} satisfies JourneyMap;
