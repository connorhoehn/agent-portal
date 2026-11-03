import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { P, RUNBOOK, SURFACE_PAGES, page } from '../_shared.ts';

// Theo Chang, a member, found a gap in the SSO runbook and wants to suggest the
// fix. Anyone may suggest; nobody but the owner decides. The walk stops short of
// sending: it proves the form is there, that it will not send an unchanged
// runbook, and that the route refuses an edit with no markdown. (The send itself
// is walked from the other side by reviewer/accept.)
export default {
  family: 'runbooks', log: 'author/propose', kind: 'journey', persona: P.theo, scenario: 'shared', identity: 'clone',
  goal: 'Open a runbook, start suggesting an edit, and see that a change needs a reason and a real difference before it can be sent',
  fields: { surface: 'suggest an edit', pages: SURFACE_PAGES },
  steps: [
    page(`/iq/runbooks/${RUNBOOK.sso.id}`, 'The runbook reads as steps with its owner, its version and where it came from',
      ['SSO setup for a new origin', 'Suggest an edit'],
      { expect: { visible: [{ testId: 'runbook-reader' }, { testId: 'runbook-reader-contents' }] } }),
    { do: 'click', target: { role: 'tab', name: 'Suggest an edit' }, audit: true, proves: 'gating',
      name: 'Suggest an edit opens the form with the runbook’s own markdown in it',
      expect: { visible: [{ testId: 'suggest-form' }, { testId: 'suggest-markdown' }, { testId: 'suggest-rationale' }] } },
    { do: 'click', target: { role: 'tab', name: 'Suggest an edit' }, audit: true, proves: 'gating',
      name: 'Send for review stays disabled until something changes and a reason is given',
      expect: { disabled: [{ testId: 'suggest-submit' }] } },
    { do: 'api', method: 'POST', url: '/api/runbooks/proposals', body: { kind: 'edit', runbook_id: RUNBOOK.sso.id, rationale: 'A step is missing.' },
      refusal: 'an edit with no markdown is rejected as a bad request before anything is stored', proves: 'gating',
      name: 'An edit with no markdown is refused', expect: { status: 400 } },
  ],
} satisfies JourneyMap;
