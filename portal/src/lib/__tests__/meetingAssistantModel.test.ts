import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_POLL_MS, assistantControls, assistantPresent, assistantStateWords, noticeText, noticeVisible, NO_ASSISTANT, parseAssistantState, rosterEntry, markWords, timeLeftWords,
  DISMISS_LABEL, DISMISS_QUESTION, ERROR_CLEAR_MS, errorStale, expiresWords, leftWords, LOADING_ASSISTANT, myWaitingActions, standingFacts, voiceWords, workingWords,
} from '../meetingAssistantModel.ts';

const view = (state: string, extra: Record<string, unknown> = {}) => parseAssistantState('c1', { state, invitedBy: 'u-a', invitedByName: 'Vera Lindqvist', youMustAck: false, ...extra });

test('a bad or missing body reads as no assistant', () => {
  for (const body of [null, undefined, 'x', [], {}, { state: 'weird' }]) assert.equal(parseAssistantState('c1', body).phase, 'none');
  assert.equal(parseAssistantState('c1', { state: 'none', youMustAck: true }).youMustAck, false);
});

test('the state is said in words and the poll is no faster than five seconds', () => {
  assert.equal(assistantStateWords(view('listening')), 'Nova is listening');
  assert.equal(assistantStateWords(view('invited')), 'Nova is joining');
  assert.equal(assistantStateWords(view('paused')), 'Nova is paused');
  assert.equal(assistantStateWords(view('left')), 'Nova has left this call');
  assert.equal(assistantStateWords(NO_ASSISTANT('c1')), null);
  assert.ok(ASSISTANT_POLL_MS >= 5000);
});

test('Invite needs the capability and an empty call; pause, resume and dismiss are for everyone', () => {
  const base = { enabled: true, inCall: true, canInvite: true };
  assert.equal(assistantControls({ ...base, view: NO_ASSISTANT('c1') }).invite, true);
  assert.equal(assistantControls({ ...base, canInvite: false, view: NO_ASSISTANT('c1') }).invite, false);
  const listening = assistantControls({ ...base, canInvite: false, view: view('listening') });
  assert.deepEqual([listening.invite, listening.pause, listening.resume, listening.dismiss], [false, true, false, true]);
  const paused = assistantControls({ ...base, canInvite: false, view: view('paused') });
  assert.deepEqual([paused.pause, paused.resume, paused.dismiss], [false, true, true]);
});

test('after dismissal Invite does not return and the bar says Nova left', () => {
  const left = assistantControls({ enabled: true, inCall: true, canInvite: true, view: view('left') });
  assert.deepEqual([left.invite, left.pause, left.resume, left.dismiss, left.left], [false, false, false, false, true]);
});

test('with the flag off, or outside a call, everything is hidden', () => {
  for (const input of [{ enabled: false, inCall: true }, { enabled: true, inCall: false }]) {
    const c = assistantControls({ ...input, canInvite: true, view: view('listening') });
    assert.equal(c.hidden, true);
    assert.equal(c.invite || c.pause || c.resume || c.dismiss || c.left, false);
  }
});

test('the notice shows only to someone who owes an acknowledgement while Nova is present', () => {
  assert.equal(noticeVisible(true, view('listening', { youMustAck: true })), true);
  assert.equal(noticeVisible(true, view('paused', { youMustAck: true })), true);
  assert.equal(noticeVisible(true, view('listening')), false);
  assert.equal(noticeVisible(true, view('left', { youMustAck: true })), false);
  assert.equal(noticeVisible(false, view('listening', { youMustAck: true })), false);
});

test('the notice names the inviter and says where speech goes, for how long, and what is kept before agreeing', () => {
  const n = noticeText(view('listening', { youMustAck: true }));
  assert.match(n.title, /Vera Lindqvist invited Nova/);
  assert.match(n.body, /speech provider/); assert.match(n.body, /retention period set by your organisation/); assert.doesNotMatch(n.body, /30 days/); assert.match(n.body, /Nothing you say is kept until you acknowledge/);
  assert.match(noticeText(view('listening', { invitedByName: null })).title, /^A participant invited Nova/);
});

test('the roster entry is a non-human line with its label and state', () => {
  assert.equal(rosterEntry(view('listening')), 'Nova (Assistant, listening)');
  assert.equal(rosterEntry(view('paused')), 'Nova (Assistant, paused)');
  assert.equal(rosterEntry(view('left')), null);
  assert.equal(assistantPresent(NO_ASSISTANT('c1')), false);
});

test('time left shows under ten minutes while listening, rounded up, never negative', () => {
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 100, ceilingSeconds: 3600 })), null);
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 3000, ceilingSeconds: 3600 })), null);
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 3061, ceilingSeconds: 3600 })), '9 min left');
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 3700, ceilingSeconds: 3600 })), '0 min left');
  assert.equal(timeLeftWords(view('paused', { listeningSeconds: 3500, ceilingSeconds: 3600 })), null);
  assert.equal(timeLeftWords(view('listening')), null);
});

test('the mark says Nova cannot hear you until you acknowledge, and the menu offers it', () => {
  const owing = view('listening', { youMustAck: true });
  assert.equal(markWords(owing, true), 'Nova cannot hear you yet');
  const controls = assistantControls({ enabled: true, inCall: true, canInvite: false, view: owing });
  assert.equal(controls.acknowledge, true);
  assert.equal(controls.extend, false);
  assert.equal(markWords(owing, false), 'Nova is listening');
  assert.equal(markWords(view('listening'), true), 'Nova is listening');
  assert.equal(assistantControls({ enabled: true, inCall: true, canInvite: true, view: view('listening') }).extend, true);
  assert.equal(assistantControls({ enabled: true, inCall: true, canInvite: true, view: view('left') }).extend, false);
});

test('the call state carries the call initiative', () => {
  assert.equal(parseAssistantState('c1', { state: 'listening', initiativeId: 'p-1' }).initiativeId, 'p-1');
  assert.equal(parseAssistantState('c1', { state: 'listening' }).initiativeId, null);
});

test('S13: Meetings shows only while the session advertises the feature', async () => {
  const { meetingsAdvertised } = await import('../meetingAssistantModel.ts');
  const { PALETTE } = await import('./../voice/__tests__/voiceHarness.ts');
  assert.equal(meetingsAdvertised({ meetingAssistant: true }), true);
  for (const s of [{ meetingAssistant: false }, {}, null, undefined]) assert.equal(meetingsAdvertised(s), false);
  const row = PALETTE.pages.find((p) => p.path === '/iq/meetings') as { feature?: string } | undefined;
  assert.equal(row?.feature, 'meetingAssistant', 'the palette row is tied to the flag');
});

test('in-call 14: until the first read nothing is offered, not even Invite', () => {
  const c = assistantControls({ enabled: true, inCall: true, canInvite: true, view: LOADING_ASSISTANT('c1') });
  assert.equal(c.hidden, false);
  assert.equal(c.invite || c.pause || c.resume || c.dismiss || c.left || c.extend || c.acknowledge, false);
  assert.equal(assistantStateWords(LOADING_ASSISTANT('c1')), null);
  assert.equal(parseAssistantState('c1', { state: 'loading' }).phase, 'none'); // only the client sets it
});

test('in-call 1: the mark says who Nova is working for, never what was asked; hearing trouble outranks it', () => {
  const one = view('listening', { openRequests: [{ askerName: 'Una Okafor', kind: 'lookup', text: 'secret' }] });
  assert.deepEqual(one.openRequests, [{ askerName: 'Una Okafor', kind: 'lookup' }]);
  assert.equal(workingWords(one), 'Nova is looking that up for Una Okafor');
  assert.equal(markWords(one, false), 'Nova is looking that up for Una Okafor');
  const two = view('listening', { openRequests: [{ askerName: 'Una Okafor', kind: 'change' }, { askerName: 'Bo', kind: 'lookup' }, { kind: 'lookup' }] });
  assert.equal(workingWords(two), "Nova is working on Una Okafor's request (+1 more)");
  assert.equal(markWords(view('listening', { hearing: 'no-audio', openRequests: [{ askerName: 'Una', kind: 'lookup' }] }), false), 'Nova cannot hear the call');
  assert.equal(workingWords(view('paused', { openRequests: [{ askerName: 'Una', kind: 'lookup' }] })), null);
  assert.deepEqual(view('left', { openRequests: [{ askerName: 'Una', kind: 'lookup' }] }).openRequests, []);
});

test('in-call 6: invited reads as joining, and the bar says when Nova cannot hear', () => {
  assert.equal(markWords(view('invited'), false), 'Nova is joining');
  assert.equal(markWords(view('listening', { hearing: 'connecting' }), false), 'Nova is connecting');
  assert.equal(markWords(view('listening', { hearing: 'no-audio' }), false), 'Nova cannot hear the call');
  assert.equal(markWords(view('listening', { hearing: 'bogus' }), false), 'Nova is listening');
});

test('in-call 3 / around 1: dismissing names its effect, and the left chip says why and that Nova cannot rejoin', () => {
  assert.equal(DISMISS_LABEL, 'Dismiss Nova for everyone');
  assert.equal(DISMISS_QUESTION, 'Nova leaves for everyone and cannot be invited again in this call.');
  assert.equal(leftWords(view('left', { leftBy: 'u-b', leftByName: 'Bo Berg' })), 'Bo Berg dismissed Nova. It cannot rejoin this call');
  assert.equal(leftWords(view('left', { leftBy: 'system', listeningSeconds: 3600, ceilingSeconds: 3600 })), 'Nova reached its time limit. It cannot rejoin this call');
  assert.equal(leftWords(view('left', { leftBy: 'system', listeningSeconds: 60, ceilingSeconds: 3600 })), 'Nova lost its connection. It cannot rejoin this call');
});

test('in-call 4: the cards waiting on this viewer, soonest first, and how long until each expires', () => {
  const v = view('listening', { waitingActions: [{ actionId: 'a2', expiresAt: 900_000, mine: true }, { actionId: 'a1', expiresAt: 300_000, mine: true }, { actionId: 'a3', expiresAt: 100, mine: false }, { actionId: 'bad' }] });
  assert.deepEqual(myWaitingActions(v).map((a) => a.actionId), ['a1', 'a2']);
  assert.equal(expiresWords(v, 'a2', 0), 'expires in 15 min');
  assert.equal(expiresWords(v, 'a1', 299_000), 'expires in 1 min');
  assert.equal(expiresWords(v, 'a3', 10_000), 'expires in 1 min');
  assert.equal(expiresWords(v, 'nope', 0), null);
});

test('in-call 8 and 9: the voice shows on the mark; the menu states who invited, the voice and who may pause or dismiss', () => {
  assert.equal(voiceWords(view('listening', { voice: true }), false), 'Voice on');
  assert.equal(voiceWords(view('listening', { voice: true }), true), 'Muted for you');
  assert.equal(voiceWords(view('listening'), true), null);
  assert.deepEqual(standingFacts(view('listening', { voice: true })), ['Invited by Vera Lindqvist', "Nova's voice is on in this call", 'Anyone here can pause or dismiss Nova']);
  assert.match(standingFacts(view('paused'))[1]!, /voice is off/);
  assert.deepEqual(standingFacts(view('left')), []);
});

test('in-call 7 / around 13: a bar error goes once the phase moves on, or after about twenty seconds', () => {
  const raised = { at: 1000, phase: 'paused' as const };
  assert.equal(errorStale(raised, 2000, 'paused'), false);
  assert.equal(errorStale(raised, 2000, 'listening'), true);
  assert.equal(errorStale(raised, 1000 + ERROR_CLEAR_MS, 'paused'), true);
  assert.ok(ERROR_CLEAR_MS >= 15_000 && ERROR_CLEAR_MS <= 30_000);
});

test('the notice reads as the agreed banner copy', () => {
  assert.equal(noticeText(view('listening', { youMustAck: true })).body,
    'Nova is listening to this call. Nothing you say is kept until you acknowledge. After that your words are sent to the speech provider and kept as text for the retention period set by your organisation. Nova writes minutes for the people in the call.');
});
