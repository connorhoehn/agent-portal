// The social tenant's channels and direct messages under dev:mock
// (docs/social-tenant-design.md §4.3–§4.5, lane S1).
//
// One fixture per thing the chat store holds, so the mock is the same
// shape as the durable store rather than a pile of pre-counted answers:
//
//   social.channels         the directory — one row per `social:ch:<slug>`
//                           (live: Aurora `social_channels`, schema/social_schema.sql)
//   social.channel-members  ChatMember rows (live: DynamoDB `chat-members`)
//   social.channel-messages ChatMessage rows for `social:` channels and DMs
//                           (live: DynamoDB `chat-messages`)
//   social.read-cursors     ChatReadReceipt rows — how far each person has read a
//                           DM (live: DynamoDB `chat-reads`); the DM list's unread
//                           count is counted from these and the messages
//   social.pins             PinnedMessage rows (live: DynamoDB `chat-pins`)
//
// Under MOCK_AURORA the gateway's chat stores READ AND WRITE these rows
// (lib/social-chat.ts), so a message posted in the browser lands here, and
// `POST /api/__mock/reset` takes it away again. Every count a route reports
// (members, last message) is a selector over these rows — never a stored number.
//
// The seed, for the cast (design §4.1):
//   #general         public, Mira's; Mira, Lena, Sana, Theo, Farah — the e2e's channel
//   #design-reviews  public, Lena's; Lena, Mira, Theo, Farah — Sana is NOT in it
//                    (the participant's join walk), nor is the operator
//   #moderators      private, Lena's; Lena and Mira only (hidden from everyone else)
//   #auth-migration  public, Vera's; Vera, Theo, Mia, Sienna — the channel bound to
//                    the p-auth-migration initiative (mock/social-bindings.ts, lane E)
//   DM Lena ↔ Sana, DM Lena ↔ Mira — so the DMs page opens on something.
// Timestamps come from the mock clock at read time (contract rule 3).

import type { ChatMember, ChatMessage, ChatReadReceipt, PinnedMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { clock, defineFixture } from './core/index.js';
import { CAST, EXTRA_CHANNELS, EXTRA_MEMBERS, HISTORY, PINS } from './social-history.js';
import { workItemComments, type WorkItemCommentRow } from './work-item-comments.js';
import { legacyCommentMessage, type LegacyWorkComment } from '../lib/work-thread.js';
import { seededPeople } from './people.js';
import { seedUserForPerson } from '../providers/identity.js';

export type SocialChannelPrivacy = 'public' | 'private';

/** One directory row. The chat channel is `social:ch:<slug>`. */
export interface SocialChannelRow {
  tenant: 'social';
  slug: string;
  name: string;
  description: string | null;
  privacy: SocialChannelPrivacy;
  createdBy: string;
  createdAt: string;
}

const ch = (slug: string) => `social:ch:${slug}`;

function seedChannels(): SocialChannelRow[] {
  return [
    { tenant: 'social', slug: 'general', name: 'General', description: 'Announcements and anything that does not have a home yet.', privacy: 'public', createdBy: 'u-mira', createdAt: clock.daysAgo(21) },
    { tenant: 'social', slug: 'design-reviews', name: 'Design reviews', description: 'Post a design, get eyes on it.', privacy: 'public', createdBy: 'u-lena', createdAt: clock.daysAgo(14) },
    { tenant: 'social', slug: 'moderators', name: 'Moderators', description: 'Moderation calls and escalations.', privacy: 'private', createdBy: 'u-lena', createdAt: clock.daysAgo(10) },
    { tenant: 'social', slug: 'auth-migration', name: 'Auth migration', description: 'Discussion for the auth migration initiative (bound to its overview in OrgIQ).', privacy: 'public', createdBy: 'u-vera', createdAt: clock.daysAgo(8) },
    // The demo history's extra channels (mock/social-history.ts).
    ...EXTRA_CHANNELS.map((c): SocialChannelRow => ({ tenant: 'social', slug: c.slug, name: c.name, description: c.description, privacy: c.privacy, createdBy: c.owner, createdAt: clock.daysAgo(c.daysAgo) })),
  ];
}

function member(channel: string, userId: string, role: 'owner' | 'member', addedBy: string, addedAt: string): ChatMember {
  return { channel, userId, role, addedBy, addedAt, historyFrom: null, removedAt: null };
}

function seedMembers(): ChatMember[] {
  return [
    member(ch('general'), 'u-mira', 'owner', 'u-mira', clock.daysAgo(21)),
    member(ch('general'), 'u-lena', 'member', 'u-lena', clock.daysAgo(20)),
    member(ch('general'), 'u-sana', 'member', 'u-sana', clock.daysAgo(18)),
    member(ch('general'), 'u-theo', 'member', 'u-theo', clock.daysAgo(12)),
    member(ch('general'), 'u-farah', 'member', 'u-farah', clock.daysAgo(9)),
    member(ch('design-reviews'), 'u-lena', 'owner', 'u-lena', clock.daysAgo(14)),
    member(ch('design-reviews'), 'u-mira', 'member', 'u-mira', clock.daysAgo(14)),
    member(ch('design-reviews'), 'u-theo', 'member', 'u-theo', clock.daysAgo(7)),
    member(ch('design-reviews'), 'u-farah', 'member', 'u-farah', clock.daysAgo(6)),
    member(ch('moderators'), 'u-lena', 'owner', 'u-lena', clock.daysAgo(10)),
    member(ch('moderators'), 'u-mira', 'member', 'u-lena', clock.daysAgo(10)),
    member(ch('auth-migration'), 'u-vera', 'owner', 'u-vera', clock.daysAgo(8)),
    member(ch('auth-migration'), 'u-theo', 'member', 'u-theo', clock.daysAgo(8)),
    member(ch('auth-migration'), 'u-mia', 'member', 'u-mia', clock.daysAgo(7)),
    member(ch('auth-migration'), 'u-release', 'member', 'u-release', clock.daysAgo(7)),
    ...Object.entries(EXTRA_MEMBERS).flatMap(([slug, ids]) => ids.map((id) => member(ch(slug), id, 'member', id, clock.daysAgo(6)))),
    ...EXTRA_CHANNELS.flatMap((c) => [
      member(ch(c.slug), c.owner, 'owner', c.owner, clock.daysAgo(c.daysAgo)),
      ...c.members.map((id) => member(ch(c.slug), id, 'member', c.owner, clock.daysAgo(Math.max(1, c.daysAgo - 1)))),
    ]),
  ];
}

/**
 * A seeded message. Its id has the library's shape — `Date.now().toString(36)`
 * of its own timestamp, then a suffix — because DynamoDB's `chat-messages`
 * sorts a channel by `messageId`: a `seed-…` id would sort after every live
 * one and pass itself off as the newest message.
 */
function msg(key: string, channel: string, userId: string, displayName: string, text: string, timestamp: string): ChatMessage {
  const id = `${new Date(timestamp).getTime().toString(36)}seed${key.replace(/[^a-z0-9]/g, '')}`;
  return { id, clientId: 'seed', userId, channel, message: text, metadata: { displayName }, timestamp };
}

/** `social:dm:<sorted ids>` for an `a|b` pair — the library's naming (lib/social-chat.ts `dmChannelFor`). */
const dmChannelFor = (pair: string): string => `social:dm:${pair.split('|').sort().join(':')}`;

/**
 * A work item's discussion is its gateway thread `orgiq:work:<id>` — the one the
 * initiative page's pane and its Discussion tab both read. The seeded human
 * comments (mock/work-item-comments.ts, mirroring schema/seed_program.sql) are
 * that thread's history: each one is exactly what the one-time migration
 * (lib/migrate-work-comments.ts) writes for it on the real backend — the same
 * pure mapping (lib/work-thread.ts legacyCommentMessage), so the mock thread and
 * a migrated one agree on ids, timestamps, provenance and sender. Authors are
 * the person's linked login (directory row) where one exists, else a
 * named-but-unlinked sender with no userId.
 */
function workThreadMessages(): ChatMessage[] {
  return workItemComments.rows().filter((c) => !c.isSystem).map((c) => legacyCommentMessage(legacyWorkComment(c)));
}

/** A fixture comment with its author resolved from the seeded directory (the migration's join, in memory). */
export function legacyWorkComment(c: WorkItemCommentRow): LegacyWorkComment {
  const user = c.authorId ? seedUserForPerson(c.authorId) : null;
  return {
    commentId: c.id, workItemId: c.workItemId,
    authorPersonId: c.authorId,
    authorPersonName: c.authorId ? seededPeople.find((p) => p.id === c.authorId)?.name ?? null : null,
    authorUserId: user?.id ?? null, authorUserDisplayName: user?.displayName ?? null,
    body: c.body, createdAt: c.createdAt,
  };
}

function seedMessages(): ChatMessage[] {
  const dmLenaSana = 'social:dm:u-lena:u-sana';
  const dmLenaMira = 'social:dm:u-lena:u-mira';
  return [
    msg('seed-general-1', ch('general'), 'u-mira', 'Mira Okafor', 'Welcome to the community workspace. Channels are where we talk in the open; DMs are for everything else.', clock.daysAgo(21)),
    msg('seed-general-2', ch('general'), 'u-lena', 'Lena Brandt', 'Moderation guidelines are pinned in #moderators for the mod team. Ping me with questions.', clock.daysAgo(3)),
    msg('seed-general-3', ch('general'), 'u-theo', 'Theo Chang', 'Is the Thursday community call still on?', clock.hoursAgo(6)),
    msg('seed-general-4', ch('general'), 'u-mira', 'Mira Okafor', 'Yes — same time, same room.', clock.hoursAgo(5)),
    msg('seed-design-1', ch('design-reviews'), 'u-lena', 'Lena Brandt', 'First pass at the onboarding flow is up. Comments by Friday, please.', clock.daysAgo(2)),
    msg('seed-design-2', ch('design-reviews'), 'u-farah', 'Farah Osei', 'The empty state on step two reads well. The progress bar feels heavy.', clock.hoursAgo(20)),
    msg('seed-auth-1', ch('auth-migration'), 'u-vera', 'Vera Green', 'Tenant two cuts over to the BFF login on Thursday. Shout here if your team still calls the SAML shim.', clock.daysAgo(2)),
    msg('seed-auth-2', ch('auth-migration'), 'u-theo', 'Theo Chang', 'Search still has one SAML callback in staging — patching it today.', clock.hoursAgo(7)),
    msg('seed-mods-1', ch('moderators'), 'u-mira', 'Mira Okafor', 'Two reports on the same thread overnight — Lena, can you take a look?', clock.hoursAgo(9)),
    msg('seed-dm-ls-1', dmLenaSana, 'u-lena', 'Lena Brandt', 'Hi Sana — welcome aboard. Shout if anything in #general is unclear.', clock.daysAgo(1)),
    msg('seed-dm-ls-2', dmLenaSana, 'u-sana', 'Sana Iqbal', 'Thanks Lena, will do.', clock.hoursAgo(22)),
    msg('seed-dm-lm-1', dmLenaMira, 'u-mira', 'Mira Okafor', 'Can you cover the Thursday call if I run late?', clock.hoursAgo(4)),
    ...workThreadMessages(),
    // Ten days of history from the whole social cast (mock/social-history.ts).
    ...[...HISTORY].sort((a, b) => b[3] - a[3]).map(([key, where, user, hours, text]) =>
      msg(`h-${key}`, where.includes('|') ? dmChannelFor(where) : ch(where), user, CAST[user] ?? user, text, clock.hoursAgo(hours))),
  ];
}

export const socialChannelsFixture = defineFixture<SocialChannelRow>({
  key: 'social.channels',
  scenarios: {
    default: seedChannels,
    empty: () => [],
    fresh: () => [],
  },
});

export const socialChannelMembersFixture = defineFixture<ChatMember>({
  key: 'social.channel-members',
  scenarios: {
    default: seedMembers,
    empty: () => [],
    fresh: () => [],
  },
});

export const socialChannelMessagesFixture = defineFixture<ChatMessage>({
  key: 'social.channel-messages',
  scenarios: {
    default: seedMessages,
    empty: () => [],
    fresh: () => [],
  },
});

/** No cursor is seeded: a person has read a DM up to their own last message (lib/social-chat.ts `unreadFor`). */
export const socialReadCursorsFixture = defineFixture<ChatReadReceipt>({
  key: 'social.read-cursors',
  scenarios: {
    default: () => [],
    empty: () => [],
  },
});

/** A DM opened (POST /dms) before its first message: the person's index row (live: DynamoDB `chat-conversations`). */
export interface SocialDmJoin { channel: string; userId: string }
export const socialDmJoinsFixture = defineFixture<SocialDmJoin>({
  key: 'social.dm-joins',
  scenarios: { default: () => [], empty: () => [] },
});

/** Pins are channel state; resetting the mock clears them independently of messages. */
export const socialPinsFixture = defineFixture<PinnedMessage>({
  key: 'social.pins',
  scenarios: { default: seedPins, empty: () => [] },
});

/** Pins, found by the key their message carries, so a pin cannot name a message the seed lacks. */
function seedPins(): PinnedMessage[] {
  const rows = socialChannelMessagesFixture.rows('default');
  const out: PinnedMessage[] = [];
  for (const [slug, key, by, hours] of PINS) {
    const m = rows.find((r) => r.channel === ch(slug) && r.id.endsWith(`seedh${key}`));
    if (!m) continue;
    out.push({ channelId: m.channel, messageId: m.id, pinnedBy: by, pinnedAt: clock.hoursAgo(hours),
      preview: m.message.slice(0, 140), author: String(m.metadata?.['displayName'] ?? m.userId ?? ''), sentAt: m.timestamp });
  }
  return out;
}

// ── Selectors (counted from the rows, never stored) ─────────────────────────

/** Active (not removed) members of `channel`. */
export function activeMembers(rows: readonly ChatMember[], channel: string): ChatMember[] {
  return rows.filter((m) => m.channel === channel && !m.removedAt);
}

/** The newest message on `channel`, or null. */
export function latestMessage(rows: readonly ChatMessage[], channel: string): ChatMessage | null {
  let best: ChatMessage | null = null;
  for (const m of rows) if (m.channel === channel && (!best || m.timestamp > best.timestamp)) best = m;
  return best;
}

/**
 * Messages from someone else on `channel` that `userId` has not read: after
 * both their read cursor and their own last message (answering a thread reads it).
 */
export function unreadFor(messages: readonly ChatMessage[], channel: string, userId: string, readAt: string | null): number {
  const mine = messages.filter((m) => m.channel === channel && m.userId === userId).map((m) => m.timestamp).sort();
  const floor = [readAt ?? '', mine[mine.length - 1] ?? ''].sort()[1] ?? '';
  return messages.filter((m) => m.channel === channel && m.userId !== userId && !m.deletedAt && m.timestamp > floor).length;
}
