import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discussionCommandLabel, railCount, readDiscussionUnread, EMPTY_DISCUSSION_UNREAD } from '../discussionUnreadModel.ts';

const thread = { channel: 'assessment:team:TEAM-005', title: 'Team TEAM-005', href: '/assessment/teams/TEAM-005?tab=discussion',
  section: '/assessment/teams', unreadCount: 2, lastMessagePreview: 'hello', place: 'a team discussion', label: 'Open the team discussion' };

test('reads the server\'s threads and counts discussions per rail door', () => {
  const out = readDiscussionUnread({ tenant: 'assessment', threads: [thread, { ...thread, channel: 'assessment:team:TEAM-006', unreadCount: 1 }] }, 'assessment');
  assert.deepEqual(out.sections, { '/assessment/teams': 2 });
  assert.deepEqual(out.threads.map(t => t.unreadCount), [2, 1]);
});

test('draws nothing for another tenant\'s reply, junk, zero counts or off-portal links', () => {
  assert.deepEqual(readDiscussionUnread({ tenant: 'orgiq', threads: [thread] }, 'assessment'), EMPTY_DISCUSSION_UNREAD);
  assert.deepEqual(readDiscussionUnread(null, 'assessment'), EMPTY_DISCUSSION_UNREAD);
  assert.deepEqual(readDiscussionUnread({ tenant: 'assessment', threads: [{ ...thread, unreadCount: 0 }, { ...thread, href: '//evil' }, { ...thread, href: 'https://x' }, 7] }, 'assessment').threads, []);
});

test('a rail door adds its discussions to what it already counts, and hides a zero', () => {
  const unread = readDiscussionUnread({ tenant: 'assessment', threads: [thread] }, 'assessment');
  assert.equal(railCount('/assessment/teams', 0, unread), 1);
  assert.equal(railCount('/assessment/teams', 3, unread), 4);
  assert.equal(railCount('/assessment/reports', 0, unread), undefined);
});

test('a palette row names the thread and its count', () => {
  const [t] = readDiscussionUnread({ tenant: 'assessment', threads: [thread] }, 'assessment').threads;
  assert.equal(discussionCommandLabel(t!), 'Team TEAM-005 — 2 new messages');
  assert.equal(discussionCommandLabel({ ...t!, unreadCount: 1 }), 'Team TEAM-005 — 1 new message');
});
