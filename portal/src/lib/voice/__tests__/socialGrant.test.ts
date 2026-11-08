// G10 (docs/voice-navigator-gaps.md §2.2): set_status writes the tenant's own
// presence entry and needs no Social grant; send_chat_message and start_call
// keep the grant, and their refusal offers the access request the plane names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { accessRequestHref, planPreparedCall, prepareToolCall, runPreparedCall, type PresenceAccess, type SocialAccess, type ToolResult } from '../tools.ts';
import { fakeFetch, route, toolContext } from './voiceHarness.ts';

const ITEM = 'role:social:moderator';

function lobby() {
  const writes: Array<[string, unknown]> = [];
  const access: PresenceAccess = {
    roster: () => [],
    lobby: () => ({ channel: 'orgiq:lobby', setStatus: (s) => { writes.push(['status', s]); }, updateMetadata: (m) => { writes.push(['meta', m]); } }),
  };
  return { access, writes };
}

function social(): SocialAccess & { writes: Array<[string, unknown]>; sends: unknown[] } {
  const writes: Array<[string, unknown]> = [];
  const sends: unknown[] = [];
  return {
    writes, sends, api: '/api/social/plane', unavailable: null, deliveries: new Map(),
    send: async (input) => { sends.push(input); },
    presence: { setStatus: (s) => { writes.push(['status', s]); }, updateMetadata: (m) => { writes.push(['meta', m]); } },
  };
}

async function call(name: string, args: unknown, ctx: ReturnType<typeof toolContext>): Promise<{ card: boolean; result: ToolResult }> {
  const prepared = prepareToolCall(name, args, ctx);
  if (!prepared.ok) return { card: false, result: prepared.result };
  const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
  if (planned && 'result' in planned) return { card: false, result: planned.result };
  return { card: !!planned, result: await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned?.plan.data) };
}

test('set_status: an orgiq member with no Social context writes the tenant lobby entry, with no card and no request', async () => {
  const { access, writes } = lobby();
  const { fetch, log } = fakeFetch([]);
  const { card, result } = await call('set_status', { status: 'away', message: 'out today' }, toolContext({ role: 'member', fetch, social: null, presence: access, deny: ['PostMessage', 'StartCall', 'ViewSocial'] }));
  assert.equal(card, false);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(writes, [['status', 'away'], ['meta', { statusMessage: 'out today' }]]);
  assert.deepEqual(result.output['on'], ['workspace']);
  assert.equal(log.length, 0);
});

test('set_status: with a Social grant the Social entry is the second write; Social alone still works; neither is a refusal', async () => {
  const { access, writes } = lobby();
  const s = social();
  const both = await call('set_status', { status: 'busy' }, toolContext({ social: s, presence: access }));
  assert.deepEqual(both.result.output['on'], ['workspace', 'Social']);
  assert.deepEqual(writes, [['status', 'busy']]);
  assert.deepEqual(s.writes, [['status', 'busy']]);
  const only = await call('set_status', { status: 'online' }, toolContext({ tenant: 'social', social: social(), presence: { roster: () => [], lobby: () => null } }));
  assert.deepEqual(only.result.output['on'], ['Social']);
  const none = await call('set_status', { status: 'online' }, toolContext({ social: null, presence: { roster: () => [], lobby: () => null } }));
  assert.equal(none.result.outcome, 'refused');
  assert.doesNotMatch(String(none.result.output['reason']), /Social/, 'no longer says status lives in Social');
});

test('send_chat_message without PostMessage: refused before any read, with the access request for the Social grant offered', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, {})]);
  const s = social();
  const { card, result } = await call('send_chat_message', { target: { kind: 'team', name: 'platform' }, text: "I'm out today" },
    toolContext({ role: 'member', fetch, social: null, deny: ['PostMessage', 'StartCall'], socialRequestItemId: ITEM }));
  assert.equal(card, false);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.output['reason'], "You don't have Social access here. I can open the access request.");
  const hint = result.output['hint'] as { href: string; item: string; note: string };
  assert.ok(hint.href.startsWith('/access/requests/new?'), hint.href);
  assert.equal(hint.href, `/access/requests/new?item=${encodeURIComponent(ITEM)}`);
  assert.equal(new URLSearchParams(hint.href.split('?')[1]).get('item'), ITEM);
  assert.match(hint.note, /ends this voice session/);
  assert.deepEqual(result.output['offer'], { tool: 'navigate', page: 'workspaces' });
  assert.equal(log.length, 0);
  assert.equal(s.sends.length, 0);
});

test('start_call without StartCall offers the same request; without a requestItemId the refusal is the plain one', async () => {
  const offered = await call('start_call', { target: { kind: 'team', name: 'platform' } }, toolContext({ social: null, deny: ['PostMessage', 'StartCall'], socialRequestItemId: ITEM }));
  assert.equal((offered.result.output['hint'] as { href: string }).href, accessRequestHref(ITEM));
  const plain = await call('send_chat_message', { target: { kind: 'team', name: 'platform' }, text: 'x' }, toolContext({ social: null, deny: ['PostMessage'] }));
  assert.equal(plain.result.output['reason'], "I can't post messages with your role.");
  assert.equal(plain.result.output['hint'], undefined);
  // In Social itself the grant is the tenant's: no access offer, whatever the context carries.
  const inSocial = await call('send_chat_message', { target: { kind: 'team', name: 'platform' }, text: 'x' }, toolContext({ tenant: 'social', social: null, deny: ['PostMessage'], socialRequestItemId: ITEM }));
  assert.equal(inSocial.result.output['hint'], undefined);
});

test('no post is ever sent without the Social context, even when can() said yes (the planner and the runner both refuse)', async () => {
  const { fetch, log } = fakeFetch([]);
  const planned = await call('send_chat_message', { target: { kind: 'dm', name: 'Ada' }, text: 'hi' }, toolContext({ fetch, social: null, socialRequestItemId: ITEM }));
  assert.equal(planned.result.outcome, 'refused');
  assert.ok((planned.result.output['hint'] as { href: string }).href.startsWith('/access/requests/new'));
  assert.equal(log.length, 0);
  // A confirmed plan whose Social context went away by confirm time sends nothing.
  const prepared = prepareToolCall('send_chat_message', { target: { kind: 'team', name: 'p' }, text: 'x' }, toolContext({ social: null }));
  assert.ok(prepared.ok);
  const run = await runPreparedCall(prepared.call, toolContext({ social: null, socialRequestItemId: ITEM }), VOICE_RUNNERS,
    { channel: 'social:ch:p', name: 'p', kind: 'channel', text: 'x', deliveryId: 'd1', key: 'k' });
  assert.equal(run.outcome, 'refused');
});
