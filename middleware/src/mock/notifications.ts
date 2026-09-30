// The header activity indicator's starting inbox under dev:mock
// (docs/social-tenant-design.md §3.5).
//
// Under dev:mock the gateway is real, so items arrive live — but its store is
// in memory (no REDIS_URL), so a fresh session opened a blank bell, and the
// floor's contract says an empty state is something you ask for, not the
// default. These rows seed that store per user at gateway attach
// (lib/notification-store.ts `rehydrateMockNotifications`), and again after
// every `POST /api/__mock/reset` / scenario switch — the store is a copy of
// the rows, the same trap as the devbox fleet, so mock-control rehydrates it.
//
// One item of each kind the producers make, for the curated cast, each in a
// tenant its recipient holds a grant in (the seed goes through the same grant
// rule as a live item, so a row for the wrong person seeds nothing):
//   - a reply        (assessment, u-farah ← Jonas, on the Rubric Overview thread)
//   - a mention      (assessment, u-asha  ← Farah, on What Counts as Evidence)
//   - a missed call  (orgiq,      u-vera  ← Nora, on the auth-migration initiative)
//   - an approval    (orgiq,      u-release, from the advisor agent)
// u-jonas starts with nothing, so the §3.6 judge's "reads 1" is his first reply.
//
// Timestamps come from the mock clock at read time; ids are stable, so a
// replay after reset does not mint a second copy of the same row.

import { clock, defineFixture } from './core/index.js';

export interface MockNotificationRow {
  id: string;
  /** The recipient. */
  userId: string;
  tenant: string;
  type: 'reply' | 'mention' | 'call-missed' | 'approval-requested';
  title: string;
  body: string;
  /** A portal path inside `tenant`. */
  href: string;
  actionLabel: string;
  timestamp: string;
  /** Extra payload fields (documentId, actorId, …) — the same keys the live producers write. */
  extra: Record<string, unknown>;
}

function seedNotifications(): MockNotificationRow[] {
  return [
    {
      id: 'mock-notif-reply-farah', userId: 'u-farah', tenant: 'assessment', type: 'reply',
      title: 'Jonas Lindqvist replied to your comment',
      body: 'On “Rubric Overview”: Thanks — the payments example is the one I had in mind.',
      href: '/assessment/workspace?doc=page%3A100002&tab=comments', actionLabel: 'Open the comments',
      timestamp: clock.hoursAgo(2),
      extra: { kind: 'reply', documentId: 'page:100002', documentTitle: 'Rubric Overview', actorId: 'u-jonas', actorName: 'Jonas Lindqvist' },
    },
    {
      id: 'mock-notif-mention-asha', userId: 'u-asha', tenant: 'assessment', type: 'mention',
      title: 'Farah Osei mentioned you',
      body: 'On “What Counts as Evidence”: @Asha Nair can you check the verbal-confirmation line against last cycle?',
      href: '/assessment/workspace?doc=rule%3Awhat-counts-as-evidence.md&tab=comments', actionLabel: 'Open the comments',
      timestamp: clock.hoursAgo(5),
      extra: { kind: 'mention', documentId: 'rule:what-counts-as-evidence.md', documentTitle: 'What Counts as Evidence', actorId: 'u-farah', actorName: 'Farah Osei' },
    },
    {
      id: 'mock-notif-missed-vera', userId: 'u-vera', tenant: 'orgiq', type: 'call-missed',
      title: 'Missed call from Nora DaSilva',
      body: 'Nobody answered — on Auth Migration.',
      href: '/iq/projects/p-auth-migration', actionLabel: 'Open the initiative',
      timestamp: clock.hoursAgo(1),
      extra: { kind: 'call-missed', callerId: 'u-nora', callerName: 'Nora DaSilva', reason: 'no-answer', channel: 'initiative:p-auth-migration' },
    },
    {
      id: 'mock-notif-approval-release', userId: 'u-release', tenant: 'orgiq', type: 'approval-requested',
      title: 'orgiq-advisor is waiting on an approval',
      body: 'Vendor renewal above the $10k threshold · $18,500',
      href: '/admin/observability/approvals', actionLabel: 'Open the approval queue',
      timestamp: clock.hoursAgo(3),
      extra: { kind: 'approval', agentId: 'orgiq-advisor' },
    },
  ];
}

export const notificationsFixture = defineFixture<MockNotificationRow>({
  key: 'notifications',
  scenarios: {
    default: seedNotifications,
    empty: () => [],
    fresh: () => [],
  },
});
