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
// One item of each kind the producers make (including the runbook proposal waiting for review), for the curated cast, each in a
// tenant its recipient holds a grant in (the seed goes through the same grant
// rule as a live item, so a row for the wrong person seeds nothing):
//   - a reply        (assessment, u-farah ← Jonas, on the Rubric Overview thread)
//   - a mention      (assessment, u-asha  ← Farah, on What Counts as Evidence)
//   - a missed call  (orgiq,      u-vera  ← Nora, on the auth-migration initiative)
//   - an approval    (orgiq,      u-release, from the agent the approval queue is holding)
//   - Mia's Mobile inbox (orgiq,  u-mia: Ben's routing PR ready for review, the
//     sprint's planned work against its envelope, and Ben mentioning her on the
//     Android back-gesture bug)
// u-jonas starts with nothing, so the §3.6 judge's "reads 1" is his first reply.
//
// Timestamps come from the mock clock at read time; ids are stable, so a
// replay after reset does not mint a second copy of the same row.

import { clock, defineFixture } from './core/index.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from './social-channels.js';
import { CAST } from './social-history.js';
import { approvalRequests } from './observability.js';

export interface MockNotificationRow {
  id: string;
  /** The recipient. */
  userId: string;
  tenant: string;
  type: 'reply' | 'mention' | 'message' | 'call-missed' | 'approval-requested' | 'system';
  title: string;
  body: string;
  /** A portal path inside `tenant`. */
  href: string;
  actionLabel: string;
  timestamp: string;
  /** The chat channel the item is about (the Mentions shelf groups on it). */
  channel?: string;
  /** Extra payload fields (documentId, actorId, …) — the same keys the live producers write. */
  extra: Record<string, unknown>;
}

/**
 * The social workspace's Activity and Mentions, derived from the seeded chat
 * rows rather than typed beside them: a mention in the last three days becomes
 * an unread `mention` for each channel member it names, and the newest message
 * of a direct conversation from the last day becomes an unread `message` for
 * the person it was sent to. Same shapes the gateway's live producers make
 * (lib/realtime-gateway.ts notifyChannelMessage, dmNotifyPlugin).
 */
function socialNotifications(): MockNotificationRow[] {
  const messages = socialChannelMessagesFixture.rows('default');
  const members = socialChannelMembersFixture.rows('default');
  const recent = clock.hoursAgo(72);
  const dayAgo = clock.hoursAgo(24);
  const out: MockNotificationRow[] = [];
  const excerpt = (t: string) => (t.length > 140 ? `${t.slice(0, 139)}…` : t);
  for (const m of messages) {
    if (!m.userId || m.timestamp < recent) continue;
    const actorName = CAST[m.userId] ?? m.userId;
    const slug = m.channel.startsWith('social:ch:') ? m.channel.slice('social:ch:'.length) : null;
    if (!slug) continue;
    const text = m.message.toLowerCase();
    for (const mem of members) {
      if (mem.channel !== m.channel || mem.removedAt || mem.userId === m.userId) continue;
      if (!text.includes(`@${(CAST[mem.userId] ?? '\u0000').toLowerCase()}`)) continue;
      out.push({
        id: `mock-notif-mention-${m.id}-${mem.userId}`, userId: mem.userId, tenant: 'social', type: 'mention',
        title: `${actorName} mentioned you in #${slug}`, body: excerpt(m.message), channel: m.channel,
        href: `/social/channels/${encodeURIComponent(slug)}`, actionLabel: 'Open the channel', timestamp: m.timestamp,
        extra: { kind: 'mention', channel: m.channel, actorId: m.userId, actorName },
      });
    }
  }
  const newestPerDm = new Map<string, (typeof messages)[number]>();
  for (const m of messages) {
    if (!m.channel.startsWith('social:dm:') || m.timestamp < dayAgo) continue;
    const seen = newestPerDm.get(m.channel);
    if (!seen || m.timestamp > seen.timestamp) newestPerDm.set(m.channel, m);
  }
  for (const m of newestPerDm.values()) {
    if (!m.userId) continue;
    const actorName = CAST[m.userId] ?? m.userId;
    for (const to of m.channel.slice('social:dm:'.length).split(':')) {
      if (to === m.userId || !CAST[to]) continue;
      out.push({
        id: `mock-notif-dm-${m.id}-${to}`, userId: to, tenant: 'social', type: 'message',
        title: `${actorName} sent you a message`, body: excerpt(m.message), channel: m.channel,
        href: `/social/dms/${encodeURIComponent(m.channel)}`, actionLabel: 'Open the conversation', timestamp: m.timestamp,
        extra: { kind: 'message', channel: m.channel, actorId: m.userId, actorName },
      });
    }
  }
  return out;
}

/** "orgiq-ingestion" → "The ingestion agent": the bell names an agent the way a person would. */
function agentLabel(agentId: string): string {
  const name = agentId.replace(/^orgiq-/, '').replace(/-/g, ' ').trim();
  return name ? `The ${name} agent` : 'An agent';
}

/**
 * Mia Singh's Mobile inbox (u-mia, program-owner): the review her initiative is
 * waiting on, the money she watches, and the question Ben asked her. Each one
 * names a real row — wi-mob-e1-s2 is in review with its PR open, Sprint 9's
 * planned work is $13.03 against bg-mob-1's $15, and Ben's comment is
 * wic-prog-20 on wi-mob-e1-b3 (mock/work-item-comments.ts).
 */
function miaNotifications(): MockNotificationRow[] {
  const item = (id: string, view?: string) =>
    `/iq/projects/p-mobile-redesign?tab=work&item=${id}${view ? `&view=${view}` : ''}`;
  return [
    {
      id: 'mock-notif-mia-review', userId: 'u-mia', tenant: 'orgiq', type: 'system',
      title: 'The deep-link routing map is ready for review',
      body: 'Ben Okafor opened the pull request: every marketing link now opens a real screen or its fallback.',
      href: item('wi-mob-e1-s2'), actionLabel: 'Open the work item', timestamp: clock.hoursAgo(6),
      extra: { kind: 'review', workItemId: 'wi-mob-e1-s2', actorId: 'u-ben', actorName: 'Ben Okafor' },
    },
    {
      id: 'mock-notif-mia-envelope', userId: 'u-mia', tenant: 'orgiq', type: 'system',
      title: 'Mobile App Redesign has 87% of its sprint envelope planned',
      body: 'Sprint 9 — Routing carries $13.03 of estimated work against its $15 envelope, with five days left.',
      href: '/iq/projects/p-mobile-redesign', actionLabel: 'Open the initiative', timestamp: clock.hoursAgo(20),
      extra: { kind: 'budget', initiativeId: 'p-mobile-redesign', sprintId: 'spr-mob-s1', grantId: 'bg-mob-1' },
    },
    {
      id: 'mock-notif-mia-mention', userId: 'u-mia', tenant: 'orgiq', type: 'mention',
      title: 'Ben Okafor mentioned you',
      body: 'On “Android back gesture conflicts with drawer swipe”: @Mia Singh do we keep the drawer swipe on Android, or open the drawer from the tab bar only?',
      href: item('wi-mob-e1-b3', 'comments'), actionLabel: 'Open the discussion', timestamp: clock.hoursAgo(3),
      extra: { kind: 'mention', workItemId: 'wi-mob-e1-b3', actorId: 'u-ben', actorName: 'Ben Okafor' },
    },
  ];
}

function seedNotifications(): MockNotificationRow[] {
  return [
    ...socialNotifications(),
    ...miaNotifications(),
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
      body: 'About the second rehearsal rollback and the callback-list step for the cutover runbook, on Auth Migration. Nobody answered.',
      href: '/iq/projects/p-auth-migration', actionLabel: 'Open the initiative',
      timestamp: clock.hoursAgo(1),
      extra: { kind: 'call-missed', callerId: 'u-nora', callerName: 'Nora DaSilva', reason: 'no-answer', channel: 'initiative:p-auth-migration' },
    },
    // The seeded open runbook proposal (mock/runbooks.seed.ts, prop-tenant-cutover-callback) waiting on the
    // org-leader: the same item the filing notice makes (lib/runbooks/notices.ts), seeded so the bell shows it
    // without a model run.
    {
      id: 'mock-notif-runbook-proposal-cutover', userId: 'u-release', tenant: 'orgiq', type: 'approval-requested',
      title: 'A change to the tenant cutover runbook is waiting for review',
      body: 'A run followed it and failed at step 2: the tenant\'s origin was never on the Cognito callback list. The change adds that step before the flag flip.',
      href: '/iq/runbooks/proposals/prop-tenant-cutover-callback', actionLabel: 'Review the proposal', timestamp: clock.hoursAgo(1.5),
      extra: { kind: 'runbook-proposal', event: 'filed', proposalId: 'prop-tenant-cutover-callback', proposalKind: 'edit', runbookId: 'rb-tenant-cutover' },
    },
    // Derived from the approval queue's own pending row, never typed beside it:
    // the bell and /admin/observability/approvals must be asking the same
    // question of the same agent.
    ...approvalRequests.rows().filter((a) => a.status === 'PENDING').map((a): MockNotificationRow => ({
      id: `mock-notif-approval-${a.approval_id.slice(-4)}`, userId: 'u-release', tenant: 'orgiq', type: 'approval-requested',
      title: `${agentLabel(a.agent_id)} is waiting on your approval`,
      body: a.reason ?? 'An agent is waiting on a human decision.',
      href: '/admin/observability/approvals', actionLabel: 'Open the approval queue',
      timestamp: a.requested_at ?? clock.hoursAgo(1),
      extra: { kind: 'approval', agentId: a.agent_id },
    })),
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
