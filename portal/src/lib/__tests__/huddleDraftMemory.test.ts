import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HuddleDraftMemory } from '../huddleDraftMemory.ts';
import type { HuddleScope } from '../huddleRoster.ts';

const empty = { html: '', files: [] as unknown[] };
const identity = JSON.stringify(['orgiq', 'actor', null, null]);
const scope = (callId: string): HuddleScope => ({ callId, actorId: 'actor', tenant: 'orgiq', identityKey: identity });
const question = { html: '<p>Unsent inquiry</p>', files: [] as unknown[] };
const page = { kind: 'work-item', id: 'wi-observability' };
const memory = () => new HuddleDraftMemory<typeof empty, typeof page>(empty);

test('a retired draft is visible before scope cleanup and keeps its original call, page and title', () => {
  const m = memory(), call = scope('call-one');
  m.setScope(identity, call, 'Original huddle'); m.setDraft(identity, call, question); m.setPage(identity, call, page);
  assert.equal(m.active(identity, null), null);
  assert.deepEqual(m.retired(identity, null), [{ scope: call, title: 'Original huddle', draft: question, page }]);
  m.setScope(identity, null, 'Huddle');
  assert.equal(m.retired(identity, null)[0].draft, question);
});

test('a replacement call stays blank while its predecessor remains an explicit unavailable destination', () => {
  const m = memory(), one = scope('one'), two = scope('two');
  m.setScope(identity, one, 'One'); m.setDraft(identity, one, question);
  assert.equal(m.retired(identity, two)[0].scope.callId, 'one');
  m.setScope(identity, two, 'Two');
  assert.equal(m.active(identity, two)!.draft, empty);
  assert.equal(m.setDraft(identity, one, { ...question, html: 'Late old-call edit' }), false);
  assert.equal(m.retired(identity, two)[0].draft, question);
});

test('an exact active reconnect preserves draft identity and staged files', () => {
  const m = memory(), call = scope('one'), draft = { html: '', files: [{ name: 'unsent.txt' }] };
  m.setScope(identity, call, 'One'); m.setDraft(identity, call, draft);
  m.setScope(identity, { ...call }, 'Reconnected');
  assert.equal(m.active(identity, call)!.draft, draft);
  assert.equal(m.retired(identity, call).length, 0);
  m.setScope(identity, null, ''); assert.equal(m.retired(identity, null)[0].draft, draft);
});

test('different actor, tenant, masquerade or unknown identity cannot read or update retired bytes', () => {
  for (const next of [JSON.stringify(['orgiq', 'other']), JSON.stringify(['assessment', 'actor']),
    JSON.stringify(['orgiq', 'actor', 'admin', 'actor']), null]) {
    const m = memory(), call = scope('one');
    m.setScope(identity, call, 'One'); m.setDraft(identity, call, question);
    assert.deepEqual(m.retired(next, null), []);
    assert.equal(m.updateRetired(next, null, 'one', { ...question, html: 'Foreign edit' }), false);
    m.setScope(next, null, ''); m.setScope(identity, null, '');
    assert.deepEqual(m.retired(identity, null), []);
  }
});

test('explicit edit or discard affects only the named retired call and leaves a current draft untouched', () => {
  const m = memory(), one = scope('one'), two = scope('two');
  m.setScope(identity, one, 'One'); m.setDraft(identity, one, question); m.setScope(identity, two, 'Two');
  const newer = { ...question, html: '<p>Current new-call draft</p>' };
  m.setDraft(identity, two, newer);
  assert.equal(m.updateRetired(identity, two, 'one', { ...question, html: '<p>Recovered source edit</p>' }), true);
  assert.equal(m.active(identity, two)!.draft, newer);
  assert.equal(m.discardRetired(identity, two, 'missing'), false);
  assert.equal(m.discardRetired(identity, two, 'one'), true);
  assert.deepEqual(m.retired(identity, two), []); assert.equal(m.active(identity, two)!.draft, newer);
});

test('several retired calls retain separate drafts and empty editor markup is not retained', () => {
  const m = memory();
  for (const id of ['one', 'two']) {
    const call = scope(id); m.setScope(identity, call, id); m.setDraft(identity, call, { ...question, html: `<p>${id}</p>` });
  }
  m.setScope(identity, scope('empty'), 'Empty'); m.setDraft(identity, scope('empty'), { html: '<p> &nbsp; </p>', files: [] });
  m.setScope(identity, null, '');
  assert.deepEqual(m.retired(identity, null).map(row => row.draft.html), ['<p>one</p>', '<p>two</p>']);
});

test('automatically attached page context with empty text/files produces no phantom retired draft', () => {
  const m = memory(), call = scope('one'); m.setScope(identity, call, 'One'); m.setPage(identity, call, page);
  assert.deepEqual(m.retired(identity, null), []);
  assert.equal(m.discardRetired(identity, null, 'one'), false);
  m.setScope(identity, null, ''); assert.deepEqual(m.retired(identity, null), []);
});

test('a newly joined call with a reused ID does not adopt or overwrite its retired source', () => {
  const m = memory(), call = scope('one'); m.setScope(identity, call, 'One'); m.setDraft(identity, call, question);
  m.setScope(identity, null, ''); m.setScope(identity, call, 'One again');
  assert.equal(m.active(identity, call)!.draft, empty);
  assert.equal(m.updateRetired(identity, call, 'one', { ...question, html: 'Explicit source edit' }), true);
  assert.equal(m.active(identity, call)!.draft, empty);
  assert.equal(m.discardRetired(identity, call, 'one'), true);
  assert.equal(m.active(identity, call)!.draft, empty);
});

test('meaningful rich media survives retirement while an empty formatted paragraph does not', () => {
  const m = memory(), call = scope('media');
  m.setScope(identity, call, 'Media'); m.setDraft(identity, call, { html: '<p><img src="owned-image.png"></p>', files: [] });
  m.setScope(identity, null, ''); assert.match(m.retired(identity, null)[0].draft.html, /owned-image/);
});
