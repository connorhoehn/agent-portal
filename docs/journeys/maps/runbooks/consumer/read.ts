import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, SURFACE_PAGES, page } from '../_shared.ts';

// Theo Chang is about to cut a tenant over and reads the runbook first: when it
// applies, the steps with the command under each, what to expect, and how the
// last runs went.
export default {
  family: 'runbooks', log: 'consumer/read', kind: 'journey', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: 'Find the cutover runbook in the library, read its steps, and see how recent runs of it went',
  fields: { surface: 'the library and a runbook', pages: SURFACE_PAGES },
  steps: [
    page('/iq/runbooks', 'The library lists the runbooks by what they cover, the cutover one among them',
      ['Runbooks', 'Cut one tenant over from SAML to Cognito', 'Bring SSO up on a new origin without breaking the picker']),
    { do: 'click', target: { role: 'button', name: /Cut one tenant over from SAML to Cognito/ }, audit: true, proves: 'shows',
      name: 'The runbook opens with when to use it, the steps and where it came from',
      expect: { url: /^\/iq\/runbooks\/rb-tenant-cutover/, visible: [{ testId: 'runbook-record' }, { testId: 'runbook-doc' }], text: ['Where it came from'] } },
    { do: 'click', target: { role: 'tab', name: 'Runs' }, audit: true, proves: 'shows',
      name: 'The Runs tab shows each step as the last runs left it, with the failure at the flip',
      expect: { visible: [{ testId: 'runbook-applications' }], text: [/flag flipped|hosted-UI|failed/i] } },
    { do: 'click', target: { role: 'tab', name: 'History' }, audit: true, proves: 'gating',
      name: 'History shows the one version; a member can read but not retire or accept',
      expect: { visible: [{ testId: 'runbook-versions' }] } },
  ],
} satisfies JourneyMap;
