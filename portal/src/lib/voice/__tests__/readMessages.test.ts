// G42 (session vs_f86d7b03, 00:42:55): get message:<ref> reads any message a
// read of this session returned, not only inbound ones; an unknown ref is
// refused as invalid-ref, never `other`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultMemory, runVoiceTool } from '../tools.ts';
import { refusalCode } from '../sessionEvents.ts';
import { InboundMemory } from '../inbound.ts';
import { fakeFetch, route, toolContext } from './voiceHarness.ts';

const SEARCH = { results: [
  { id: 'msg-41', type: 'message', title: 'The deploy freeze starts Friday at noon', subtitle: 'Lena Brandt', description: 'in #platform', href: '/social/channels/platform' },
  { id: 'msg-42', type: 'message', title: 'Rollback plan is in the doc', subtitle: 'Mira Okafor' },
], total: 2 };

test('G42: after search type message, get message:<first ref> returns its text; message:bogus is invalid-ref', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/search', 200, SEARCH)]);
  const ctx = toolContext({ tenant: 'social', fetch, results: new ResultMemory(), inbox: new InboundMemory(), allow: ['ViewSocial', 'Search'] });
  const found = await runVoiceTool('search', { query: 'deploy freeze', type: 'message' }, ctx);
  assert.equal(found.outcome, 'done', found.summary);
  const first = (found.output['rows'] as Array<{ ref: string }>)[0]!.ref;
  assert.equal(first, 'message:msg-41');
  const read = await runVoiceTool('get', { ref: first }, ctx);
  assert.equal(read.outcome, 'done', read.summary);
  assert.match(String(read.output['text']), /^The deploy freeze starts Friday at noon/);
  assert.equal(read.output['from'], 'Lena Brandt');
  // One with no page of its own is kept too.
  assert.match(String((await runVoiceTool('get', { ref: 'message:msg-42' }, ctx)).output['text']), /Rollback plan/);
  const bogus = await runVoiceTool('get', { ref: 'message:bogus' }, ctx);
  assert.equal(bogus.outcome, 'refused');
  assert.equal(refusalCode(bogus.output), 'invalid-ref');
  assert.match(String(bogus.output['next']), /kind:id/);
});

test('G42: a channel\'s recent rows carry message refs that get reads back whole', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/channels/platform', 200, { channel: { id: 'c1', slug: 'platform', name: 'platform' },
    recent: [{ id: 'm-7', message: 'Standup moved to 10:30 tomorrow because of the all-hands', metadata: { displayName: 'Sana Iqbal' } }] })]);
  const ctx = toolContext({ tenant: 'social', fetch, results: new ResultMemory(), allow: ['ViewSocial'] });
  const part = await runVoiceTool('get', { ref: 'channel:platform', part: 'recent' }, ctx);
  assert.equal(part.outcome, 'done', part.summary);
  assert.equal((part.output['rows'] as Array<{ ref?: string }>)[0]!.ref, 'message:m-7');
  const one = await runVoiceTool('get', { ref: 'message:m-7' }, ctx);
  assert.equal(one.output['text'], 'Standup moved to 10:30 tomorrow because of the all-hands');
  assert.equal(one.output['from'], 'Sana Iqbal');
});

test('G42: the refusals that used to read as `other` now name invalid-ref or not-read-yet', () => {
  assert.equal(refusalCode({ reason: 'Pass a row\'s ref as a result gave it, such as "initiative:<id>", or its position.' }), 'invalid-ref');
  assert.equal(refusalCode({ reason: '"dm" records are not read here.' }), 'invalid-ref');
  assert.equal(refusalCode({ reason: 'There is no row 4 in the last result. List or search first.' }), 'not-read-yet');
});
