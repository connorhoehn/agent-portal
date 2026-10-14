// The A0 decision walk (docs/access-journeys/PROTOCOL.md "The A0 decision walk"):
// Omar approves step 1 of Rhea's request and a replay of the same decision is
// refused with 409. It WRITES, so it runs only inside a request-scoped mock
// world (lane M, realSession withMockScope): a copy-on-write scope of the
// default world, so the decision lands in the scope and nobody else sees it.
// HELD: the decision also rings the bell through lib/notification-store.ts, an
// in-memory mirror no scope reaches, so walking it today writes to the shared
// inbox. Lift the hold when the notification store is scoped.
import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { APPROVER } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/decision-walk', kind: 'surface', persona: APPROVER,
  scenario: { scope: 'default' }, writes: true,
  hold: 'an approval rings the bell through lib/notification-store.ts, an in-memory mirror no mock scope reaches (docs/mock-floor.md), so the walk would write to the shared inbox',
  goal: 'Omar approves the manager step of Rhea’s request with a comment, and a replayed decision is refused',
  fields: { surface: 'request', pages: 'portal/src/pages/access/RequestRecordPage.tsx,middleware/src/routes/access.ts' },
  steps: [
    { do: 'navigate', url: '/access/requests/req-0001', name: 'Open Rhea’s request req-0001 at its manager step', expect: { visible: [{ testId: 'access-request-decision' }] } },
    { do: 'fill', target: { testId: 'access-request-comment' }, value: 'Rhea needs this for the SSO cutover; approved as her manager.', name: 'Write the decision comment', audit: false, auditReason: 'a half-filled form' },
    { do: 'click', target: { testId: 'access-request-approve' }, name: 'Approve asks for confirmation, quoting the comment', state: 'dialog-open', proves: 'keyboard', expect: { visible: [{ role: 'alertdialog' }] } },
    { do: 'click', target: { role: 'button', name: 'Approve', within: { role: 'alertdialog' } }, writes: true, name: 'Confirm: the step is recorded and the next step becomes current', state: 'decided', proves: 'role-gating', expect: { text: [/Recorded: approve on step 1/], absent: [{ testId: 'access-request-decision' }] } },
    { do: 'api', method: 'POST', url: '/api/access/requests/req-0001/steps/1/decide', body: { decision: 'approve' }, writes: true, name: 'Replaying the same decision answers 409', proves: 'role-gating', expect: { status: 409 } },
    { do: 'navigate', url: '/access/requests/req-missing', name: 'Open req-missing: Request not found', state: 'not-found', proves: 'empty-state', expectConsole: /404|Not Found/i, expect: { text: ['Request not found'] } },
  ],
} satisfies JourneyMap;
