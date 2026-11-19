import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codeBlockLanguage, consentOffLine, offForFact, interviewLobbyName, interviewOfLobby, isInterviewLobby, knockPromptId, pollsWaiting, readAdmission,
  SUGGESTION_RECEIPTS, SUGGESTIONS_PAUSED_LINE, SUGGESTIONS_MODEL_PAUSED_LINE, pausedLine, pollsSuggestion, readSuggestion, readsConsents, suggestionPath, suggestionPromptId,
  suggestionReadBudgetMs, suggestionWaitMs, startSuggestionPoll, suggestionForPrompt, NO_SUGGESTION, escSkipsSuggestion, pollsConsents,
  INTERVIEW_HINT_ENDED, INTERVIEW_HINT_KNOCK, hintsAfter, WAITING_FALLBACK_MS,
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

test('a quote with no words in it is no quote: a suggestion never shows an empty "Based on"', async () => {
  for (const q of ['', ' . ', '…', '"."']) {
    const out = await readSuggestion('iv-1', reply(200, { suggestion: { ...SG, basedOn: q }, paused: null, retryAfterMs: 90_000 }));
    assert.equal(out.suggestion?.basedOn, null);
  }
  const kept = await readSuggestion('iv-1', reply(200, { suggestion: { ...SG, basedOn: '. Actually, wait. That breaks' }, paused: null, retryAfterMs: 1 }));
  assert.equal(kept.suggestion?.basedOn, 'Actually, wait. That breaks');
});

test('reading a suggestion: the shape, a budget pause, and not-found or failure as nothing', async () => {
  const ok = await readSuggestion('iv-1', reply(200, { suggestion: SG, paused: null, retryAfterMs: 90_000 }));
  assert.equal(ok.suggestion?.competency.name, 'Collaboration');
  assert.equal(ok.retryAfterMs, 90_000);
  const paused = await readSuggestion('iv-1', reply(200, { suggestion: null, paused: 'budget', retryAfterMs: 1 }));
  assert.equal(paused.paused, 'budget');
  assert.equal(paused.retryAfterMs, 10_000);
  assert.equal((await readSuggestion('iv-1', reply(200, { suggestion: null, paused: 'model', retryAfterMs: 1 }))).paused, 'model');
  assert.equal((await readSuggestion('iv-1', reply(200, { suggestion: null, paused: 'other', retryAfterMs: 1 }))).paused, null);
  assert.equal((await readSuggestion('iv-1', reply(404))).suggestion, null);
  assert.equal((await readSuggestion('iv-1', (async () => { throw new Error('x'); }) as unknown as typeof fetch)).suggestion, null);
  assert.equal((await readSuggestion('iv-1', reply(200, { suggestion: { id: 1 } }))).suggestion, null);
});

test('a panel member never sees a paused line; the lead sees it only for the budget; the receipt does not promise speech', () => {
  assert.equal(pausedLine('lead', 'budget'), SUGGESTIONS_PAUSED_LINE);
  assert.equal(pausedLine('panel', 'budget'), null);
  assert.equal(pausedLine('lead', null), null);
  assert.equal(pausedLine('lead', 'model'), SUGGESTIONS_MODEL_PAUSED_LINE);
  assert.equal(pausedLine('panel', 'model'), null);
  assert.equal('milo-ask' in SUGGESTION_RECEIPTS, false, 'Have Milo ask has no fixed receipt: it says what the server did (miloAskReceipt)');
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

test('I3.4b: Esc on a showing suggestion skips it once on the server, so the read starts again; nothing else is skipped', () => {
  assert.equal(escSkipsSuggestion(true, 'sg-1', null), 'sg-1');
  assert.equal(escSkipsSuggestion(true, 'sg-1', 'sg-1'), null); // sent already
  assert.equal(escSkipsSuggestion(false, 'sg-1', null), null); // the deck is open
  assert.equal(escSkipsSuggestion(true, null, null), null); // Esc with no suggestion (the knock, the End question)
});

test('I3.4j: the open room reads the candidate\'s answers again until they exist, then stops; nobody outside the room reads them', () => {
  assert.equal(pollsConsents('lead', true, undefined), true); // the first read has not come back
  assert.equal(pollsConsents('lead', true, { answered: false }), true);
  assert.equal(pollsConsents('panel', true, { answered: false }), true);
  assert.equal(pollsConsents('lead', true, { answered: true }), false);
  assert.equal(pollsConsents(null, true, { answered: false }), false);
  assert.equal(pollsConsents('lead', false, { answered: false }), false);
});

test('the idle room lists only what is off, in a fixed order (E4 #37)', () => {
  assert.equal(offForFact(['milo', 'recording', 'transcription']), 'recording, transcript, Milo');
  assert.equal(offForFact(['transcription']), 'transcript');
  assert.equal(offForFact([]), null);
  assert.equal(offForFact(undefined), null);
});

test('back to a running call: the joined interview is read off the lobby, and its live row says "Back to the call" instead of Join', async () => {
  const { joinedInterviewOf, roomEntryLabel, interviewLobbyName } = await import('../interviewsRoom.ts');
  assert.equal(joinedInterviewOf(interviewLobbyName('iv-s4e8u2zk'), true), 'iv-s4e8u2zk');
  assert.equal(joinedInterviewOf(interviewLobbyName('iv-s4e8u2zk'), false), null);
  assert.equal(joinedInterviewOf('social:dm:abc', true), null);
  assert.equal(roomEntryLabel('iv-s4e8u2zk', 'iv-s4e8u2zk'), 'Back to the call');
  assert.equal(roomEntryLabel('iv-s4e8u2zk', 'iv-other'), 'Join');
  assert.equal(roomEntryLabel('iv-s4e8u2zk', null), 'Join');
});

test('the lost call: the call service\'s not-in-call refusal for the call this viewer was in marks it lost; nothing else does', async () => {
  const { nextCallLoss, refusedCallOf } = await import('../interviewsRoom.ts');
  const refusal = { type: 'error', service: 'call', message: 'Not in this call', code: 'not-in-call', action: 'participant-state', callId: 'c-1', lobbyName: 'interviews:interview:iv-1' };
  assert.equal(refusedCallOf(refusal), 'c-1');
  for (const other of [{ ...refusal, code: 'watch-denied' }, { ...refusal, service: 'chat' }, { ...refusal, type: 'call' }, { ...refusal, callId: '' }, null, 'x', {}]) {
    assert.equal(refusedCallOf(other), null, JSON.stringify(other));
  }
  // Only the call last joined: a refusal while a join settles, or about another call, changes nothing.
  assert.deepEqual(nextCallLoss(null, { kind: 'refused', callId: 'c-1' }, 'c-1'), { callId: 'c-1' });
  assert.equal(nextCallLoss(null, { kind: 'refused', callId: 'c-1' }, null), null);
  assert.equal(nextCallLoss(null, { kind: 'refused', callId: 'c-0' }, 'c-1'), null);
  // Further refusals for the same call keep the same loss.
  const lost = { callId: 'c-1' };
  assert.equal(nextCallLoss(lost, { kind: 'refused', callId: 'c-1' }, 'c-1'), lost);
});

test('the lost call: a server end of the joined call is a loss, the viewer\'s own leave is not', async () => {
  const { nextCallLoss } = await import('../interviewsRoom.ts');
  assert.deepEqual(nextCallLoss(null, { kind: 'ended', callId: 'c-1', reason: 'peer-disconnected' }, 'c-1'), { callId: 'c-1' });
  assert.deepEqual(nextCallLoss(null, { kind: 'ended', callId: 'c-1', reason: 'rejoin-grace-expired' }, 'c-1'), { callId: 'c-1' });
  for (const reason of ['left', 'switched', 'declined', 'no-answer', null]) {
    assert.equal(nextCallLoss(null, { kind: 'ended', callId: 'c-1', reason }, 'c-1'), null, String(reason));
  }
  // The room's own leave of the dead call (reason `left`) keeps the loss it is acting on.
  const lost = { callId: 'c-1' };
  assert.equal(nextCallLoss(lost, { kind: 'ended', callId: 'c-1', reason: 'left' }, 'c-1'), lost);
});

test('the lost call: the next call joined in the lobby clears it, and so does the interview closing', async () => {
  const { nextCallLoss } = await import('../interviewsRoom.ts');
  const lost = { callId: 'c-1' };
  assert.equal(nextCallLoss(lost, { kind: 'joined', callId: 'c-2' }, 'c-1'), null);
  // Still holding the dead call (before the room leaves it) is not a new call.
  assert.equal(nextCallLoss(lost, { kind: 'joined', callId: 'c-1' }, 'c-1'), lost);
  assert.equal(nextCallLoss(lost, { kind: 'closed' }, 'c-1'), null);
  assert.equal(nextCallLoss(null, { kind: 'joined', callId: 'c-2' }, 'c-1'), null);
});

test('the lost call: the room leaves the dead call it still holds, then joins whatever call is on in the lobby', async () => {
  const { holdsLostCall, rejoinsAfterLoss } = await import('../interviewsRoom.ts');
  const lost = { callId: 'c-1' };
  assert.equal(holdsLostCall(lost, 'c-1'), true);
  assert.equal(holdsLostCall(lost, null), false);
  assert.equal(holdsLostCall(lost, 'c-2'), false);
  assert.equal(holdsLostCall(null, 'c-1'), false);
  // The lead's restart (a new call), or the others' call that went on (the same id, now joined afresh).
  assert.equal(rejoinsAfterLoss(lost, 'c-2'), true);
  assert.equal(rejoinsAfterLoss(lost, 'c-1'), true);
  assert.equal(rejoinsAfterLoss(lost, null), false);
  assert.equal(rejoinsAfterLoss(null, 'c-2'), false);
});

test('the lost call: the lead is offered the restart; the panel and the candidate are told they rejoin', async () => {
  const { callLossWords } = await import('../interviewsRoom.ts');
  const lead = callLossWords('lead');
  assert.equal(lead.title, 'The call dropped');
  assert.equal(lead.action, 'Restart the call');
  assert.match(lead.body, /interview is still on/);
  assert.equal(callLossWords('panel').action, null);
  assert.match(callLossWords('panel').body, /rejoin as soon as the call is back/);
  assert.equal(callLossWords('candidate').action, null);
  assert.match(callLossWords('candidate').body, /rejoin as soon as your interviewer restarts the call/);
});

test('after a lost call the room says Milo left with it only when Milo\'s record says so; the lead is told how to bring Milo back', async () => {
  const { miloLostLine } = await import('../interviewsRoom.ts');
  const leftWithCall = { phase: 'left', leftReason: 'call-ended' };
  assert.equal(miloLostLine(leftWithCall, 'lead'), 'Milo left when the call dropped. Invite Milo again from the bar once the call is back.');
  assert.equal(miloLostLine(leftWithCall, 'panel'), 'Milo left when the call dropped.');
  assert.equal(miloLostLine(leftWithCall, null), null);
  // Dismissed earlier, or never in the call: the line is not drawn.
  assert.equal(miloLostLine({ phase: 'left', leftReason: null }, 'lead'), null);
  assert.equal(miloLostLine({ phase: 'none', leftReason: null }, 'lead'), null);
  assert.equal(miloLostLine({ phase: 'listening', leftReason: null }, 'lead'), null);
  assert.equal(miloLostLine(null, 'lead'), null);
});

test('the lost call: the server\'s lobby report is the answer a waking client always gets; it seats the call, then says when it is gone', async () => {
  const { nextCallLoss, seatConfirmed } = await import('../interviewsRoom.ts');
  // The lobby reports this client's own call: it is seated (also while its media still reads "connecting").
  assert.equal(seatConfirmed('c-1', 'c-1'), true);
  assert.equal(seatConfirmed(null, 'c-1'), false);
  assert.equal(seatConfirmed('c-2', 'c-1'), false);
  assert.equal(seatConfirmed('c-1', null), false);
  // Seated in c-1 and still holding it: the reconnect's snapshot says no call, or another call, so c-1 is gone.
  assert.deepEqual(nextCallLoss(null, { kind: 'lobby', callId: null, held: 'c-1' }, 'c-1'), { callId: 'c-1' });
  assert.deepEqual(nextCallLoss(null, { kind: 'lobby', callId: 'c-2', held: 'c-1' }, 'c-1'), { callId: 'c-1' });
  assert.equal(nextCallLoss(null, { kind: 'lobby', callId: 'c-1', held: 'c-1' }, 'c-1'), null);
  // A call being started and not yet seated (a stale empty report), or a call this client already left, is not lost.
  assert.equal(nextCallLoss(null, { kind: 'lobby', callId: null, held: 'c-3' }, 'c-1'), null);
  assert.equal(nextCallLoss(null, { kind: 'lobby', callId: null, held: 'c-3' }, null), null);
  assert.equal(nextCallLoss(null, { kind: 'lobby', callId: null, held: null }, 'c-1'), null);
});

// The room's live hints: one event is enough to read again now; the poll is only the slow fallback.
const ev = (eventType: string, interviewId = 'iv-1') => ({ eventType, detail: { interviewId } });

test('hintsAfter: a knock and an end each read as one hint, once, from where the reader left off', () => {
  const events = [ev(INTERVIEW_HINT_KNOCK), ev(INTERVIEW_HINT_ENDED)];
  assert.deepEqual(hintsAfter(events, 0, 'iv-1'), { next: 2, knock: true, ended: true });
  assert.deepEqual(hintsAfter(events, 1, 'iv-1'), { next: 2, knock: false, ended: true });
  assert.deepEqual(hintsAfter(events, 2, 'iv-1'), { next: 2, knock: false, ended: false });
});

test('hintsAfter: another interview\'s hint, a foreign event and a shorter list are not this room\'s', () => {
  assert.deepEqual(hintsAfter([ev(INTERVIEW_HINT_KNOCK, 'iv-2'), ev('work-graph.changed')], 0, 'iv-1'), { next: 2, knock: false, ended: false });
  assert.deepEqual(hintsAfter([ev(INTERVIEW_HINT_KNOCK)], 5, 'iv-1'), { next: 1, knock: false, ended: false });
});

test('the fallback poll is slow now that hints carry the news', () => {
  assert.equal(WAITING_FALLBACK_MS, 15_000);
});
