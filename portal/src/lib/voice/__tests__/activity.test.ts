// activity (G6, docs/voice-navigator-gaps.md §2.2): the social app's activity
// (the social index's live huddles, the caller's call log, messages, pins) and
// the presence roster the footer shows, answered from fixtures; every row is a
// row the backing read returned to this persona, capped and keepable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FIELD_CHARS, MAX_ROWS, ResultMemory, runVoiceTool, SOCIAL_SEARCH_PLANE, type PresenceAccess, type SocialAccess } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';

const HUDDLE = { type: 'huddle', id: 'call-1', title: 'Live huddle in #platform', kind: 'Huddle', subtitle: 'In the huddle now: Mira Chen, Lena Park', status: 'live', href: '/social/calls', updatedAt: '2026-11-08T11:40:00Z', score: 4 };
const MISSED = [
  { type: 'calllog', id: 'call-7|u-sana', title: 'Missed call from Lena Park', kind: 'Missed call', subtitle: 'DM Lena Park · missed', status: 'missed', href: '/social/calls', updatedAt: '2026-11-08T09:10:00Z', score: 3 },
  { type: 'calllog', id: 'call-4|u-sana', title: 'Missed call from Theo Ruiz', kind: 'Missed call', subtitle: '#design-reviews · missed', status: 'missed', href: '/social/calls', updatedAt: '2026-11-06T16:00:00Z', score: 3 },
];
const MESSAGES = [
  { type: 'message', id: 'social:ch:platform|m2', title: 'Deploy is green again', kind: 'Message', subtitle: '#platform · Mira Chen', href: '/social/channels/platform', updatedAt: '2026-11-08T08:00:00Z', score: 1 },
  { type: 'message', id: 'social:ch:platform|m1', title: 'Rolling back the gateway', kind: 'Message', subtitle: '#platform · Lena Park', href: '/social/channels/platform', updatedAt: '2026-11-05T08:00:00Z', score: 1 },
];
const PIN = { type: 'pin', id: 'social:ch:platform|m0', title: 'Runbook: gateway rollback', kind: 'Pin', subtitle: 'Pinned in #platform by Mira Chen', href: '/social/channels/platform', updatedAt: '2026-11-08T07:00:00Z', score: 1 };
const WORK = { type: 'work', id: 'w-12', title: 'Migrate session store', subtitle: 'Story · Auth Migration · Ada Okafor', href: '/iq/projects/p-auth-migration?item=w-12', updatedAt: '2026-11-08T10:00:00Z' };

/** The social index as the route answers: the fixture rows of the asked type (the real route filters by type and phrase). */
function socialIndex(prefix: string): Route {
  return (req) => {
    if (req.method !== 'GET' || !req.url.startsWith(`${prefix}?`)) return undefined;
    const type = new URLSearchParams(req.url.split('?')[1]).get('type');
    const results = type === 'huddle' ? [HUDDLE] : type === 'calllog' ? MISSED : type === 'message' ? MESSAGES : type === 'pin' ? [PIN] : [];
    return { status: 200, body: { query: '', results, counts: {}, total: results.length } };
  };
}

const ROSTER: PresenceAccess = { roster: () => [
  { userId: 'u-mira', name: 'Mira Chen', status: 'online' },
  { userId: 'u-lena', name: 'Lena Park', status: 'away', message: 'out today' },
], lobby: () => null };
const SOCIAL = { api: '/api/social/plane', unavailable: null, send: async () => {}, presence: null, deliveries: new Map() } as SocialAccess;

test('live-calls, missed-calls, messages and pins each answer from the social index, with the index\'s own rows', async () => {
  const { fetch, log } = fakeFetch([socialIndex('/api/social/search')]);
  const ctx = toolContext({ tenant: 'social', role: 'participant', fetch, allow: ['ViewSocial'], results: new ResultMemory() });
  const live = await runVoiceTool('activity', { scope: 'live-calls', since: null, who: null }, ctx);
  assert.equal(live.outcome, 'done');
  assert.equal(live.summary, '1 live huddle: Live huddle in #platform (In the huddle now: Mira Chen, Lena Park)');
  assert.deepEqual((live.output['rows'] as Array<Record<string, unknown>>).map((r) => r['ref']), ['huddle:call-1']);
  const missed = await runVoiceTool('activity', { scope: 'missed-calls' }, ctx);
  assert.equal(missed.summary, '2 missed calls; latest: Missed call from Lena Park');
  const messages = await runVoiceTool('activity', { scope: 'messages', since: 'yesterday' }, ctx);
  assert.deepEqual((messages.output['rows'] as Array<{ title: string }>).map((r) => r.title), ['Deploy is green again'], 'since drops the older message');
  const pins = await runVoiceTool('activity', { scope: 'pins' }, ctx);
  assert.equal((pins.output['rows'] as unknown[]).length, 1);
  assert.deepEqual(log.map((r) => r.url), [
    '/api/social/search?q=live+huddles&type=huddle&limit=50',
    '/api/social/search?q=missed+calls&type=calllog&limit=50',
    '/api/social/search?type=message&limit=50',
    '/api/social/search?q=pins&type=pin&limit=50',
  ]);
  // The rows are kept for open: "open the first one" opens the pin's conversation.
  assert.equal(ctx.results!.find('1')!.href, '/social/channels/platform');
});

test('who narrows the index read by the name; a live huddle is never hidden by since', async () => {
  const { fetch, log } = fakeFetch([socialIndex('/api/social/search')]);
  const ctx = toolContext({ tenant: 'social', role: 'participant', fetch, allow: ['ViewSocial'] });
  const live = await runVoiceTool('activity', { scope: 'live-calls', who: 'Mira', since: 'today' }, ctx);
  assert.equal((live.output['rows'] as unknown[]).length, 1);
  await runVoiceTool('activity', { scope: 'messages', who: 'Lena Park' }, ctx);
  assert.deepEqual(log.map((r) => r.url), ['/api/social/search?q=live+huddles+Mira&type=huddle&limit=50', '/api/social/search?q=Lena+Park&type=message&limit=50']);
});

test('outside Social the same reads go to the plane, and need the Social grant: refused with no request without it', async () => {
  const { fetch, log } = fakeFetch([socialIndex(SOCIAL_SEARCH_PLANE)]);
  const granted = await runVoiceTool('activity', { scope: 'live-calls' }, toolContext({ fetch, social: SOCIAL }));
  assert.equal(granted.outcome, 'done');
  assert.equal(log[0]!.url, `${SOCIAL_SEARCH_PLANE}?q=live+huddles&type=huddle&limit=50`);
  const { fetch: f2, log: l2 } = fakeFetch([socialIndex(SOCIAL_SEARCH_PLANE)]);
  const none = await runVoiceTool('activity', { scope: 'missed-calls' }, toolContext({ fetch: f2, social: null }));
  assert.equal(none.outcome, 'refused');
  assert.match(String(none.output['reason']), /Social, which this session cannot reach/);
  assert.equal(l2.length, 0);
  // In Social, a role without ViewSocial is refused before any read.
  const viewer = await runVoiceTool('activity', { scope: 'pins' }, toolContext({ tenant: 'social', fetch: f2, deny: ['ViewSocial'] }));
  assert.equal(viewer.outcome, 'refused');
  assert.equal(l2.length, 0);
});

test('online lists only the roster the footer shows, with no request at all', async () => {
  const { fetch, log } = fakeFetch([]);
  const online = await runVoiceTool('activity', { scope: 'online' }, toolContext({ fetch, presence: ROSTER }));
  assert.equal(online.outcome, 'done');
  assert.deepEqual(online.output['rows'], [{ name: 'Mira Chen', status: 'online' }, { name: 'Lena Park', status: 'away', message: 'out today' }]);
  assert.equal(online.summary, '2 people online: Mira Chen, Lena Park');
  const lena = await runVoiceTool('activity', { scope: 'online', who: 'lena' }, toolContext({ fetch, presence: ROSTER }));
  assert.deepEqual((lena.output['rows'] as Array<{ name: string }>).map((r) => r.name), ['Lena Park']);
  // In Social each person opens on their contact page.
  const memory = new ResultMemory();
  const social = await runVoiceTool('activity', { scope: 'online' }, toolContext({ tenant: 'social', fetch, presence: ROSTER, results: memory }));
  assert.equal((social.output['rows'] as Array<{ ref: string }>)[0]!.ref, 'contact:u-mira');
  assert.equal(memory.find('contact:u-lena')!.href, '/social/contacts/u-lena');
  assert.equal(log.length, 0);
  const off = await runVoiceTool('activity', { scope: 'online' }, toolContext({ fetch, presence: null }));
  assert.equal(off.outcome, 'refused');
});

test('work reads a person\'s work items from the orgiq search; it is not offered in Social', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/search?', 200, { results: [WORK], total: 1 })]);
  const ada = await runVoiceTool('activity', { scope: 'work', who: 'Ada Okafor' }, toolContext({ fetch, allow: ['Search'] }));
  assert.equal(ada.summary, '1 work item for "Ada Okafor"; latest: Migrate session store');
  assert.equal(log[0]!.url, '/api/search?q=Ada+Okafor&type=work&sort=recent&limit=50');
  await runVoiceTool('activity', { scope: 'work' }, toolContext({ fetch, allow: ['Search'] }));
  assert.equal(log[1]!.url, '/api/search?q=my+work&type=work&sort=recent&limit=50', 'no name is the caller\'s own work');
  const social = await runVoiceTool('activity', { scope: 'work', who: 'Ada' }, toolContext({ tenant: 'social', fetch }));
  assert.equal(social.outcome, 'refused');
  assert.equal(log.length, 2);
});

test('recent: messages, pins and missed calls since yesterday, newest first, with work in orgiq; an unreachable Social is named, not fatal', async () => {
  const { fetch, log } = fakeFetch([socialIndex(SOCIAL_SEARCH_PLANE), route('GET', '/api/search?', 200, { results: [WORK], total: 1 })]);
  const r = await runVoiceTool('activity', { scope: 'recent' }, toolContext({ fetch, social: SOCIAL, allow: ['Search'] }));
  assert.equal(r.outcome, 'done');
  assert.deepEqual((r.output['rows'] as Array<{ title: string }>).map((x) => x.title),
    ['Migrate session store', 'Missed call from Lena Park', 'Deploy is green again', 'Runbook: gateway rollback']);
  assert.equal(r.output['since'], new Date(2026, 10, 7).toISOString(), 'yesterday by default');
  assert.equal(log.length, 4);
  const { fetch: f2 } = fakeFetch([route('GET', '/api/search?', 200, { results: [WORK], total: 1 })]);
  const noSocial = await runVoiceTool('activity', { scope: 'recent', since: 'last week' }, toolContext({ fetch: f2, social: null, allow: ['Search'] }));
  assert.equal(noSocial.outcome, 'done');
  assert.deepEqual(noSocial.output['unread'], ['Calls, messages and pins are in Social, which this session cannot reach.']);
});

test('since must be a past date; a failed index read is a failure, a 403 a role refusal', async () => {
  const bad = await runVoiceTool('activity', { scope: 'messages', since: 'tomorrow' }, toolContext({ tenant: 'social', allow: ['ViewSocial'] }));
  assert.equal(bad.outcome, 'refused');
  const { fetch } = fakeFetch([route('GET', '/api/social/search', 403, {})]);
  const forbidden = await runVoiceTool('activity', { scope: 'pins' }, toolContext({ tenant: 'social', fetch, allow: ['ViewSocial'] }));
  assert.match(String(forbidden.output['reason']), /Your role cannot read Social activity/);
  const { fetch: down } = fakeFetch([route('GET', '/api/social/search', 500, {})]);
  assert.equal((await runVoiceTool('activity', { scope: 'pins' }, toolContext({ tenant: 'social', fetch: down, allow: ['ViewSocial'] }))).outcome, 'failed');
});

test('property: an activity result carries no string over 120 characters and no list over 10 rows', async () => {
  const huge = 'x'.repeat(400);
  const many = Array.from({ length: 30 }, (_, i) => ({ type: 'message', id: `c|m${i}`, title: huge, subtitle: huge, href: '/social/channels/c', updatedAt: `2026-11-08T0${i % 10}:00:00Z` }));
  const { fetch } = fakeFetch([route('GET', '/api/social/search', 200, { results: many, total: 30 })]);
  const r = await runVoiceTool('activity', { scope: 'messages' }, toolContext({ tenant: 'social', fetch, allow: ['ViewSocial'] }));
  const walk = (v: unknown): void => {
    if (typeof v === 'string') assert.ok(v.length <= MAX_FIELD_CHARS);
    else if (Array.isArray(v)) { assert.ok(v.length <= MAX_ROWS); v.forEach(walk); }
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(r.output);
  assert.equal(r.output['count'], 30);
});
