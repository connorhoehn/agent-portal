import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMiloLine, laterPosition, newestTime, shouldMark, unreadBadgeText, unreadCount, unreadWords } from '../callChatUnreadModel.ts';

const at = (s: number) => new Date(Date.parse('2026-11-19T10:00:00Z') + s * 1000).toISOString();
const ME = 'u-me';
const rows = [
  { id: 'a', userId: 'u-lead', timestamp: at(1) },
  { id: 'b', userId: ME, timestamp: at(2) },
  { id: 'c', userId: 'agent:meeting-assistant', timestamp: at(3) },
  { id: 'd', userId: 'u-lead', timestamp: at(4), message: 'https://example.test/spec' },
];

test('counts others\' messages after my position; my own never count', () => {
  assert.equal(unreadCount(rows, ME, null), 3);
  assert.equal(unreadCount(rows, ME, at(1)), 2);
  assert.equal(unreadCount(rows, ME, at(4)), 0);
  assert.equal(unreadCount([{ id: 'x', userId: ME, timestamp: at(9) }], ME, null), 0);
});

test('nothing counts while my position loads, or without a viewer', () => {
  assert.equal(unreadCount(rows, ME, undefined), 0);
  assert.equal(unreadCount(rows, '', null), 0);
});

test('a history replay at or before my position is not new', () => {
  const replay = [...rows, ...rows];
  assert.equal(unreadCount(replay, ME, at(4)), 0);
  assert.equal(unreadCount([...replay, { id: 'e', userId: 'u-wen', timestamp: at(5) }], ME, at(4)), 1);
});

test('deleted messages do not count', () => {
  assert.equal(unreadCount([{ id: 'z', userId: 'u-lead', timestamp: at(9), deletedAt: at(10) }], ME, null), 0);
});

test('the Milo tab counts Milo\'s lines, the chat beside it the people\'s', () => {
  assert.equal(unreadCount(rows, ME, null, isMiloLine), 1);
  assert.equal(unreadCount(rows, ME, null, (m) => !isMiloLine(m)), 2);
  assert.equal(isMiloLine({ userId: 'agent:nova' }), true);
  assert.equal(isMiloLine({ userId: 'u-lead' }), false);
});

test('opening the tab marks the newest shown message, once, and a position only moves forward', () => {
  assert.equal(newestTime(rows), at(4));
  assert.equal(newestTime(rows, isMiloLine), at(3));
  assert.equal(newestTime([]), null);
  assert.equal(shouldMark(null, at(4)), true);
  assert.equal(shouldMark(at(4), at(4)), false);
  assert.equal(shouldMark(at(3), at(4)), true);
  assert.equal(shouldMark(at(3), null), false);
  assert.equal(laterPosition(at(5), at(4)), at(5));
  assert.equal(laterPosition(at(3), at(4)), at(4));
  assert.equal(laterPosition(null, at(4)), at(4));
  assert.equal(laterPosition(at(4), null), at(4));
});

test('the bubble and its words', () => {
  assert.equal(unreadBadgeText(1), '1');
  assert.equal(unreadBadgeText(120), '99+');
  assert.equal(unreadWords(2), '2 unread');
});
