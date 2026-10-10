import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMessagePortraits } from '../messagePortraits.ts';
import { readSharedPeople } from '../../components/shell/tenantDirectModel.ts';

const directory = readSharedPeople({ tenant: 'social', lobby: 'social:lobby', dmPrefix: 'social:dm:',
  me: { userId: 'u-vera', displayName: 'Vera Green', avatarUrl: '/avatars/vera-current.webp' },
  people: [{ userId: 'u-farah', displayName: 'Farah Osei', avatarUrl: '/avatars/farah.webp' },
    { userId: 'u-member', displayName: 'Member' }] });

test('old history and pin-loaded messages receive current photos without altering stored metadata', () => {
  const messages = [
    { id: 'old', userId: 'u-vera', metadata: { avatarUrl: '/avatars/old.svg', displayName: 'Vera Green', pageReference: { id: 'work-1' } } },
    { id: 'pin', userId: 'u-farah', metadata: { pin: true } },
    { id: 'neutral', userId: 'u-member', metadata: { displayName: 'Member' } },
  ];
  const decorated = withMessagePortraits(messages, directory);
  assert.equal(decorated[0]!.metadata.avatarUrl, '/avatars/vera-current.webp');
  assert.equal(decorated[1]!.metadata.avatarUrl, '/avatars/farah.webp');
  assert.deepEqual(decorated[0]!.metadata.pageReference, { id: 'work-1' });
  assert.equal(messages[0]!.metadata.avatarUrl, '/avatars/old.svg');
  assert.equal('avatarUrl' in messages[1]!.metadata, false);
  assert.equal(decorated[2], messages[2]);
});

test('an unavailable or invalid directory cannot invent a photo; unchanged histories keep their identity', () => {
  const messages = [{ userId: 'unknown', metadata: { displayName: 'Unknown' } }];
  assert.equal(withMessagePortraits(messages, null), messages);
  assert.equal(withMessagePortraits(messages, readSharedPeople({ tenant: 'other', lobby: 'social:lobby', dmPrefix: 'social:dm:', me: directory!.me, people: [] })), messages);
  assert.equal(withMessagePortraits(messages, directory), messages);
  const current = [{ userId: 'u-vera', metadata: { avatarUrl: '/avatars/vera-current.webp' } }];
  assert.equal(withMessagePortraits(current, directory), current);
});
