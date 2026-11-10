// One conversation per initiative: a bound initiative's Discussion pane and
// composer are its channel; an unbound one keeps its own thread.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOT_A_MEMBER_REASON, discussionAccess, initiativeDiscussionTarget } from '../initiativeDiscussionTarget.ts';

const bound = (joined: boolean) => ({ data: { binding: { channel: 'social:ch:auth-migration', slug: 'auth-migration', name: 'Auth migration' }, joined }, error: null });

test('bound: the channel is the discussion, named by its slug; there is no second thread', () => {
  const t = initiativeDiscussionTarget({ projectId: 'p-auth-migration', socialAvailable: true, binding: bound(true) });
  assert.deepEqual(t, { kind: 'channel', channel: 'social:ch:auth-migration', slug: 'auth-migration', label: '#auth-migration', joined: true });
  assert.deepEqual(discussionAccess(t, { postMessage: true, dispatch: false }), { maySend: true, reason: null },
    'posting takes Social\'s rule (PostMessage and membership), not the thread\'s writers');
  assert.equal(discussionAccess(t, { postMessage: false, dispatch: true }).maySend, false);
});

test('bound, not a member: read-only with the channel\'s own reason', () => {
  const t = initiativeDiscussionTarget({ projectId: 'p-auth-migration', socialAvailable: true, binding: bound(false) });
  assert.equal(t.kind, 'channel');
  const access = discussionAccess(t, { postMessage: true, dispatch: true });
  assert.equal(access.maySend, false);
  assert.equal(access.reason, `You are not a member of #auth-migration. ${NOT_A_MEMBER_REASON}`);
});

test('unbound, no Social grant, or an unreadable binding: the initiative\'s own thread, as before', () => {
  const thread = { kind: 'thread', channel: 'orgiq:initiative:p-x', label: 'Initiative discussion' };
  assert.deepEqual(initiativeDiscussionTarget({ projectId: 'p-x', socialAvailable: true, binding: { data: { binding: null, joined: false }, error: null } }), thread);
  assert.deepEqual(initiativeDiscussionTarget({ projectId: 'p-x', socialAvailable: false, binding: bound(true) }), thread);
  assert.deepEqual(initiativeDiscussionTarget({ projectId: 'p-x', socialAvailable: true, binding: { data: null, error: 'HTTP 500' } }), thread);
  assert.deepEqual(discussionAccess(thread as never, { postMessage: true, dispatch: false }),
    { maySend: false, reason: 'You can read messages. Your current role cannot post to this discussion.' });
});

test('while the binding is read, nothing is mounted (never one conversation, then the other)', () => {
  const t = initiativeDiscussionTarget({ projectId: 'p-auth-migration', socialAvailable: true, binding: { data: null, error: null } });
  assert.deepEqual(t, { kind: 'loading' });
  assert.equal(discussionAccess(t, { postMessage: true, dispatch: true }).maySend, false);
});
