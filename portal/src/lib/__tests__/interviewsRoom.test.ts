import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codeBlockLanguage, consentOffLine, interviewLobbyName, interviewOfLobby, isInterviewLobby, knockPromptId, pollsWaiting, readAdmission,
  SUGGESTION_RECEIPTS, SUGGESTIONS_PAUSED_LINE, pausedLine, pollsSuggestion, readSuggestion, readsConsents, suggestionPath, suggestionPromptId,
  suggestionReadBudgetMs, suggestionWaitMs, startSuggestionPoll, suggestionForPrompt, NO_SUGGESTION,
  roomCallTitle, roomHref, roomStartMs, startsOnJoin, timeLeftLabel, timeLeftTone,
} from '../interviewsRoom.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T14:00:00.000Z');

test('the lobby name is C1\'s, and only an interview\'s lobby reads as one', () => {
  assert.equal(interviewLobbyName('iv-1'), 'interviews:interview:iv-1');
  assert.equal(interviewOfLobby('interviews:interview:iv-1'), 'iv-1');
  for (const other of ['orgiq:initiative:p-1', 'social:room:abc', 'interviews:interview:iv-1~breakout~r1', 'assessment:team:TEAM-1', '', null, undefined]) {
    assert.equal(isInterviewLobby(other), false, String(other));
  }
  assert.equal(roomHref('iv 1'), '/interviews/rounds/iv%201/room');
});

test('time left is plain words from the start and the round\'s length', () => {
  assert.equal(timeLeftLabel(T0, 45, T0), '45 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 33 * MIN), '12 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 44.5 * MIN), '1 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 45 * MIN), '1 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 48 * MIN + 10_000), 'Over by 3 min');
  assert.equal(timeLeftLabel(T0, 45, T0 - 5 * MIN), 'Starts in 5 min');
  assert.equal(timeLeftLabel(null, 45, T0), null);
  assert.equal(timeLeftLabel(T0, 0, T0), null);
  assert.equal(timeLeftTone('Over by 3 min'), 'warning');
  assert.equal(timeLeftTone('12 min left'), 'secondary');
});

test('time counts from the set time, else from when the call started', () => {
  assert.equal(roomStartMs('2026-11-16T14:00:00.000Z', T0 + 9 * MIN), T0);
  assert.equal(roomStartMs(null, T0 + 9 * MIN), T0 + 9 * MIN);
  assert.equal(roomStartMs(null, '2026-11-16T14:00:00.000Z'), T0);
  assert.equal(roomStartMs(null, null), null);
});

test('the lead\'s join starts an accepted or ready interview; nobody else\'s does', () => {
  assert.equal(startsOnJoin({ seat: 'lead', state: 'accepted' }), true);
  assert.equal(startsOnJoin({ seat: 'lead', state: 'ready' }), true);
  assert.equal(startsOnJoin({ seat: 'lead', state: 'live' }), false);
  assert.equal(startsOnJoin({ seat: 'panel', state: 'ready' }), false);
});

test('only the lead asks whether the candidate is waiting, and stops once they are in', () => {
  const waiting = { state: 'waiting' as const, knockedAt: 'k', decidedAt: null };
  assert.equal(pollsWaiting('lead', null, 'ready'), true);
  assert.equal(pollsWaiting('lead', waiting, 'live'), true);
  assert.equal(pollsWaiting('lead', { ...waiting, state: 'admitted' }, 'live'), false);
  assert.equal(pollsWaiting('panel', null, 'live'), true); // any seat reads whether the candidate is here
  assert.equal(pollsWaiting('panel', { ...waiting, state: 'admitted' }, 'live'), false);
  assert.equal(pollsWaiting(null, null, 'live'), false);
  assert.equal(pollsWaiting('lead', null, 'ended'), false);
  // A new knock is a new prompt.
  assert.notEqual(knockPromptId('iv-1', waiting), knockPromptId('iv-1', { ...waiting, knockedAt: 'k2' }));
});

test('a waiting route that is not there reads as nobody waiting', async () => {
  const notFound = (async () => new Response('{"error":"Not found"}', { status: 404 })) as typeof fetch;
  assert.equal(await readAdmission('iv-1', notFound), null);
  const broken = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.equal(await readAdmission('iv-1', broken), null);
  const knocked = (async () => new Response(JSON.stringify({ admission: { state: 'waiting', knockedAt: 'k', decidedAt: null } }))) as typeof fetch;
  assert.deepEqual(await readAdmission('iv-1', knocked), { state: 'waiting', knockedAt: 'k', decidedAt: null });
});

test('what the candidate turned off is one plain line; nothing off is no line', () => {
  assert.equal(consentOffLine(['recording']), 'Recording is off for this interview');
  assert.equal(consentOffLine(['recording', 'transcription']), 'Recording and transcription are off for this interview');
  assert.equal(consentOffLine(['transcription', 'recording', 'milo']), 'Transcription, recording and Milo are off for this interview');
  assert.equal(consentOffLine([]), null);
  assert.equal(consentOffLine(null), null);
});

test('the call\'s name and the code block\'s language', () => {
  assert.equal(roomCallTitle({ round: { id: 'r', name: 'Leadership', type: 'behavioural', minutes: 60 }, candidate: { name: 'Nadia' } }), 'Leadership with Nadia');
  assert.equal(codeBlockLanguage('typescript'), 'ts');
  assert.equal(codeBlockLanguage('javascript'), 'js');
  assert.equal(codeBlockLanguage('swift'), 'text');
});

const SG = { id: 's1', text: 'Tell me about a time you disagreed.', competency: { id: 'c1', name: 'Collaboration' }, basedOn: 'the migration story', shownAt: 'x' };
const reply = (status: number, body?: unknown) => (async () => new Response(JSON.stringify(body ?? {}), { status })) as unknown as typeof fetch;

test('the room asks for a suggestion only for the live lead in the call with none waiting', () => {
  assert.equal(pollsSuggestion('lead', 'live', true, null), true);
  assert.equal(pollsSuggestion('panel', 'live', true, null), false);
  assert.equal(pollsSuggestion(null, 'live', true, null), false);
  assert.equal(pollsSuggestion('lead', 'ready', true, null), false);
  assert.equal(pollsSuggestion('lead', 'live', false, null), false);
  assert.equal(pollsSuggestion('lead', 'live', true, SG), false);
});

test('the wait is the server\'s, between 10 seconds and 2 minutes; the budget is the round plus half an hour', () => {
  assert.equal(suggestionWaitMs(500), 10_000);
  assert.equal(suggestionWaitMs(45_000), 45_000);
  assert.equal(suggestionWaitMs(9_999_999), 120_000);
  assert.equal(suggestionWaitMs(undefined), 30_000);
  assert.equal(suggestionReadBudgetMs(60), 90 * 60_000);
  assert.equal(suggestionPath('iv 1'), '/api/interviews/interviews/iv%201/suggestion');
  assert.equal(suggestionPromptId('iv-1', 's1'), 'interview-suggestion:iv-1:s1');
});

test('reading a suggestion: the shape, a budget pause, and not-found or failure as nothing', async () => {
  const ok = await readSuggestion('iv-1', reply(200, { suggestion: SG, paused: null, retryAfterMs: 90_000 }));
  assert.equal(ok.suggestion?.competency.name, 'Collaboration');
  assert.equal(ok.retryAfterMs, 90_000);
  const paused = await readSuggestion('iv-1', reply(200, { suggestion: null, paused: 'budget', retryAfterMs: 1 }));
  assert.equal(paused.paused, 'budget');
  assert.equal(paused.retryAfterMs, 10_000);
  assert.equal((await readSuggestion('iv-1', reply(404))).suggestion, null);
  assert.equal((await readSuggestion('iv-1', (async () => { throw new Error('x'); }) as unknown as typeof fetch)).suggestion, null);
  assert.equal((await readSuggestion('iv-1', reply(200, { suggestion: { id: 1 } }))).suggestion, null);
});

test('a panel member never sees a paused line; the lead sees it only for the budget; the receipt does not promise speech', () => {
  assert.equal(pausedLine('lead', 'budget'), SUGGESTIONS_PAUSED_LINE);
  assert.equal(pausedLine('panel', 'budget'), null);
  assert.equal(pausedLine('lead', null), null);
  assert.equal(SUGGESTION_RECEIPTS['milo-ask'], 'Sent to the call chat');
  assert.equal(readsConsents('panel', true), true);
  assert.equal(readsConsents('lead', false), false);
  assert.equal(readsConsents(null, true), false);
});

// The hook itself cannot be rendered in the portal's node runner (no DOM), so the loop it runs is tested directly.
function pollHarness(deadline: number, answers: Array<Awaited<ReturnType<typeof readSuggestion>>>) {
  let nowMs = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  let reads = 0;
  const seen: unknown[] = [];
  const stop = startSuggestionPoll({
    read: async () => answers[Math.min(reads++, answers.length - 1)],
    onRead: (o) => { seen.push(o); },
    now: () => nowMs, deadline,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (t) => { timers.delete(t as number); },
  });
  const tick = async () => { const [id, t] = [...timers][0] ?? []; if (id === undefined) return false; timers.delete(id); t!.fn(); await new Promise((r) => setImmediate(r)); return true; };
  return { stop, timers, tick, reads: () => reads, seen, setNow: (n: number) => { nowMs = n; } };
}
const none = (retryAfterMs: number) => ({ ...NO_SUGGESTION, retryAfterMs });

test('the suggestion poll reads again on the server\'s wait, stops when one arrives, and stops at its deadline', async () => {
  const h = pollHarness(1000, [none(30_000), none(30_000), { ...NO_SUGGESTION, suggestion: SG }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.reads(), 1);
  assert.equal([...h.timers.values()][0].ms, 30_000);
  assert.equal(await h.tick(), true);
  assert.equal(h.reads(), 2);
  assert.equal(await h.tick(), true);
  assert.equal(h.reads(), 3);
  assert.equal(h.timers.size, 0, 'no further read is scheduled once a suggestion arrived');
  const late = pollHarness(1000, [none(30_000)]);
  await new Promise((r) => setImmediate(r));
  late.setNow(1001);
  await late.tick();
  assert.equal(late.reads(), 1, 'past the deadline the next read does not happen');
  assert.equal(late.timers.size, 0);
});

test('stopping the suggestion poll clears its timer and drops a read that was still in flight', async () => {
  const h = pollHarness(1_000_000, [none(10_000)]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.timers.size, 1);
  h.stop();
  assert.equal(h.timers.size, 0);
  let release!: (v: Awaited<ReturnType<typeof readSuggestion>>) => void;
  const seen: unknown[] = [];
  const stop = startSuggestionPoll({
    read: () => new Promise((r) => { release = r; }), onRead: (o) => seen.push(o), now: () => 0, deadline: 10,
    setTimer: () => { throw new Error('must not schedule after stop'); }, clearTimer: () => {},
  });
  stop();
  release(none(10_000));
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 0);
});

test('the footer builds a suggestion prompt only for the lead\'s registration', () => {
  assert.equal(suggestionForPrompt(true, SG), SG);
  assert.equal(suggestionForPrompt(false, SG), null);
  assert.equal(suggestionForPrompt(true, null), null);
});
