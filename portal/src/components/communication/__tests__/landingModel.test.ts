// The Communication landing (landingModel.ts): the user's own default
// conversation opens directly; the overview only when there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landingDecision, type LandingInput } from '../landingModel.ts';

const base = '/iq/communication';
const input = (over: Partial<LandingInput> = {}): LandingInput => ({
  ready: true, groups: [], groupsLoading: false, bindings: new Map(), channels: [], conversations: [], ...over,
});
const auth = { kind: 'initiative' as const, id: 'p-auth-migration', name: 'Auth Migration' };
const rag = { kind: 'initiative' as const, id: 'p-rag-search', name: 'RAG Search' };

test('waits until the channel and DM lists answer', () => {
  assert.deepEqual(landingDecision(input({ ready: false }), base), { kind: 'wait' });
});

test('the first group whose bound channel the user is in opens first', () => {
  const d = landingDecision(input({
    groups: [rag, auth],
    bindings: new Map([
      ['initiative:p-rag-search', { binding: null, joined: false }],
      ['initiative:p-auth-migration', { binding: { slug: 'auth-migration' }, joined: true }],
    ]),
    channels: [{ slug: 'general', joined: true, lastMessageAt: '2026-10-07T16:00:00Z' }, { slug: 'auth-migration', joined: true, lastMessageAt: '2026-10-07T10:00:00Z' }],
  }), base);
  assert.deepEqual(d, { kind: 'open', href: '/iq/communication/channels/auth-migration', reason: 'group' });
});

test('a bound channel the user has not joined does not open; the most recent conversation does', () => {
  const d = landingDecision(input({
    groups: [auth],
    bindings: new Map([['initiative:p-auth-migration', { binding: { slug: 'auth-migration' }, joined: false }]]),
    channels: [{ slug: 'auth-migration', joined: false, lastMessageAt: '2026-10-07T18:00:00Z' }, { slug: 'general', joined: true, lastMessageAt: '2026-10-07T12:00:00Z' }],
    conversations: [{ channel: 'dm:u-a:u-b', lastMessageAt: '2026-10-07T13:00:00Z' }],
  }), base);
  assert.deepEqual(d, { kind: 'open', href: `/iq/communication/dms/${encodeURIComponent('dm:u-a:u-b')}`, reason: 'recent' });
});

test('an unanswered binding waits, then the recent conversation decides', () => {
  const pending = input({ groups: [auth], channels: [{ slug: 'general', joined: true, lastMessageAt: null }] });
  assert.deepEqual(landingDecision(pending, base), { kind: 'wait' });
  assert.deepEqual(landingDecision(pending, base, true), { kind: 'open', href: '/iq/communication/channels/general', reason: 'recent' });
  assert.deepEqual(landingDecision(input({ groupsLoading: true }), base), { kind: 'wait' });
});

test('nothing joined and no DMs: the overview', () => {
  assert.deepEqual(landingDecision(input({ channels: [{ slug: 'events', joined: false, lastMessageAt: null }] }), base), { kind: 'overview' });
});
