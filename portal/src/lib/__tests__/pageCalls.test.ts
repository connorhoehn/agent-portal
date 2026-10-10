import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPageCallLobby, lobbyContext, pageCallCard, pageHuddleLogBodies, rowPeople, startPageHuddleTracker, tenantCallEntries, type PageCallRow } from '../pageCalls.ts';

const nameOf = (id: string) => ({ 'u-asha': 'Asha Nair', 'u-jonas': 'Jonas Lindqvist' } as Record<string, string>)[id] ?? id;
const row = (over: Partial<PageCallRow> = {}): PageCallRow => ({
  callId: 'c1', direction: 'joined', callerId: 'u-asha', callerName: 'Asha Nair', targetUserIds: ['u-jonas'], lobbyName: 'assessment:team:TEAM-001',
  audioOnly: false, outcome: 'answered', startedAt: '2026-10-07T10:00:00.000Z', durationMs: 754_000, ...over,
} as PageCallRow);

test('only the four page lobby families are call lobbies', () => {
  for (const ok of ['orgiq:initiative:p-auth', 'assessment:team:TEAM-001', 'assessment:doc:h:abc', 'pipelines:run:r-7']) assert.equal(isPageCallLobby(ok), true, ok);
  for (const no of ['assessment:team:001', 'orgiq:work:w-1', 'social:dm:a:b', 'orgiq:huddle:c1', 'pipelines:def:d1', '', null]) assert.equal(isPageCallLobby(no as string), false, String(no));
});

test('a lobby names its page and where it lives', () => {
  assert.deepEqual(lobbyContext('orgiq:initiative:p-auth'), { kind: 'Initiative', id: 'p-auth', label: 'Initiative p-auth', href: '/iq/projects/p-auth' });
  assert.equal(lobbyContext('assessment:team:TEAM-001')?.href, '/assessment/teams/TEAM-001');
  assert.equal(lobbyContext('pipelines:run:r-7')?.href, '/pipelines/runs/r-7');
  assert.equal(lobbyContext('social:room:x'), null);
});

test('participants: you first, then the caller, then the rest, each named once', () => {
  assert.deepEqual(rowPeople(row(), 'u-jonas', nameOf).map(p => p.displayName), ['You', 'Asha Nair']);
  assert.deepEqual(rowPeople(row(), 'u-asha', nameOf).map(p => p.displayName), ['You', 'Jonas Lindqvist']);
});

test('a call card carries duration and participants; a missed one carries its outcome and no duration', () => {
  const card = pageCallCard(row(), 'u-jonas', nameOf);
  assert.equal(card.durationMs, 754_000);
  assert.equal(card.live, false);
  assert.equal(card.participants.length, 2);
  const missed = pageCallCard(row({ outcome: 'missed', direction: 'incoming', durationMs: undefined as never }), 'u-jonas', nameOf);
  assert.equal(missed.outcome, 'no-answer');
  assert.equal('durationMs' in missed, false);
});

test('tenant rows read "<page> · <others>", format the duration and count only incoming misses', () => {
  const [a, b] = tenantCallEntries([row(), row({ callId: 'c2', direction: 'incoming', outcome: 'missed', durationMs: undefined as never })], 'u-jonas', nameOf);
  assert.equal(a!.who, 'Team TEAM-001 · Asha Nair');
  assert.equal(a!.duration, '12m 34s');
  assert.equal(a!.missed, false);
  assert.equal(b!.missed, true);
  assert.equal(a!.href, '/assessment/teams/TEAM-001');
});

test('a huddle is reported when the first peer is seen, with the real join time and every peer by then; ended follows', () => {
  const t = startPageHuddleTracker('c1', 'assessment:team:TEAM-001', new Date('2026-10-07T10:00:00.000Z'));
  const who = { selfId: 'u-asha', selfName: 'Asha Nair' };
  assert.deepEqual(pageHuddleLogBodies(t, who, false), []);
  t.peers.add('u-jonas');
  const first = pageHuddleLogBodies(t, who, false);
  assert.deepEqual(first.map(b => [b.action, b.targetUserIds, b.at]), [['joined', ['u-jonas'], '2026-10-07T10:00:00.000Z']]);
  assert.deepEqual(pageHuddleLogBodies(t, who, false), [], 'reported once');
  const end = pageHuddleLogBodies(t, who, true, new Date('2026-10-07T10:12:34.000Z'));
  assert.deepEqual(end.map(b => [b.action, b.at]), [['ended', '2026-10-07T10:12:34.000Z']]);
});

test('a huddle nobody joined still reports joined then ended when it ends', () => {
  const t = startPageHuddleTracker('c9', 'pipelines:run:r-7', new Date('2026-10-07T10:00:00.000Z'));
  assert.deepEqual(pageHuddleLogBodies(t, { selfId: 'u-kofi' }, true).map(b => b.action), ['joined', 'ended']);
});
