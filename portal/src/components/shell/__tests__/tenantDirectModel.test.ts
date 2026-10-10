import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConversations, onlineIds, readSharedPeople, tenantDmChannel } from '../tenantDirectModel.ts';

const body = { tenant: 'orgiq', me: { userId: 'u-a', displayName: 'A' }, lobby: 'orgiq:lobby', dmPrefix: 'orgiq:dm:',
  people: [{ userId: 'u-b', displayName: 'B' }, { userId: 'u-a', displayName: 'A' }, { nope: 1 }] };

test('reads the shared directory and drops the caller and malformed rows', () => {
  assert.deepEqual(readSharedPeople(body)?.people, [{ userId: 'u-b', displayName: 'B' }]);
});

test('refuses a response whose realtime names are not its own tenant\'s', () => {
  assert.equal(readSharedPeople({ ...body, lobby: 'social:lobby' }), null);
  assert.equal(readSharedPeople({ ...body, dmPrefix: 'social:dm:' }), null);
  assert.equal(readSharedPeople({ ...body, me: null }), null);
  assert.equal(readSharedPeople(null), null);
});

test('names one DM for both people', () => {
  assert.equal(tenantDmChannel('orgiq:dm:', ['u-b', 'u-a']), 'orgiq:dm:u-a:u-b');
  assert.equal(tenantDmChannel('orgiq:dm:', ['u-a', 'u-b', 'u-a']), 'orgiq:dm:u-a:u-b');
});

test('counts only listed people who are online', () => {
  const people = [{ userId: 'u-b', displayName: 'B' }];
  assert.deepEqual([...onlineIds([{ metadata: { userId: 'u-b' } }, { metadata: { userId: 'u-x' } }, { status: 'away', metadata: { userId: 'u-b' } }], people)], ['u-b']);
  assert.equal(onlineIds([{ status: 'away', metadata: { userId: 'u-b' } }], people).size, 0);
});

test('reads only this tenant\'s own 1:1 conversations', () => {
  const dir = readSharedPeople(body);
  const good = { channel: 'orgiq:dm:u-a:u-b', peers: [{ userId: 'u-b', displayName: 'B' }], lastMessageAt: 't', lastMessagePreview: 'hi', unreadCount: 2 };
  const rows = [good, { ...good, channel: 'other:dm:u-a:u-b' }, { ...good, channel: 'orgiq:dm:u-a:u-c' },
    { ...good, peers: [{ userId: 'u-b', displayName: 'B' }, { userId: 'u-c', displayName: 'C' }] }];
  assert.deepEqual(readConversations({ tenant: 'orgiq', conversations: rows }, dir).map(c => [c.channel, c.unreadCount]), [['orgiq:dm:u-a:u-b', 2]]);
  assert.deepEqual(readConversations({ tenant: 'assessment', conversations: rows }, dir), []);
  assert.deepEqual(readConversations(null, dir), []);
});
