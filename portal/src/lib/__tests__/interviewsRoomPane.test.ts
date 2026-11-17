// The room as decision 21 draws it (UI round 1, lane ROOM): the pane's tabs (U1), the round's crumb (U6), the
// footer's time and consent chip, and the facts shown before the call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NOT_ANSWERED_LINE, ROOM_MESSAGE_TAB, callTimeLabel, candidateLine, consentChip, defaultRoomTab, guestRoomNameFor, isGuestUserId, miloInviteBlock, staffRoomNameFor, panelLine, roomPaneWidth,
  roomTabIds, roomTabOf, roomTabs, roundCrumbLabel,
} from '../interviewsRoom.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T14:00:00.000Z');

test('the pane has the round type’s tabs in order, opens on the first, and Message selects Chat', () => {
  assert.deepEqual(roomTabIds('technical'), ['pad', 'questions', 'milo', 'chat']);
  assert.deepEqual(roomTabIds('behavioural'), ['plan', 'milo', 'chat']);
  assert.deepEqual(roomTabs('behavioural').map((t) => t.label), ['Plan', 'Milo', 'Chat']);
  assert.equal(defaultRoomTab('technical'), 'pad');
  assert.equal(defaultRoomTab('behavioural'), 'plan');
  assert.equal(ROOM_MESSAGE_TAB, 'chat');
  for (const type of ['technical', 'behavioural'] as const) assert.ok(roomTabIds(type).includes(ROOM_MESSAGE_TAB));
});

test('a tab id the round does not have keeps the current tab', () => {
  assert.equal(roomTabOf('behavioural', 'pad', 'plan'), 'plan');
  assert.equal(roomTabOf('behavioural', 'chat', 'plan'), 'chat');
  assert.equal(roomTabOf('technical', 'questions', 'pad'), 'questions');
  assert.equal(roomTabOf('technical', 'nonsense', 'milo'), 'milo');
});

test('the pane is wide enough for code in a technical round and narrow otherwise', () => {
  assert.deepEqual(roomPaneWidth('technical'), { min: 562, max: 760 });
  assert.deepEqual(roomPaneWidth('behavioural'), { min: 362, max: 460 });
});

// The shell's split sets the page's share as a flex-basis rounded to 0.1% (ratio = 1 - min / width, then
// Math.round(ratio * 1000) / 1000). The pane's column is what is left; at every container width a 1280 or 1440 window
// can give the room it stays on or over decision 21's floor (I2.4o measured 559 at 1440 before the margin).
test('after the split rounds the page\'s share, the pane column holds the floor at every room width', () => {
  for (const type of ['technical', 'behavioural'] as const) {
    const floor = type === 'technical' ? 560 : 360;
    const { min } = roomPaneWidth(type);
    for (let width = 1000; width <= 1440; width += 1) {
      const share = Math.round((1 - min / width) * 1000) / 1000;
      const column = Math.round(width - share * width);
      assert.ok(column >= floor, `${type} at ${width}: ${column} px`);
    }
  }
});

test('the round’s crumb names the candidate, then the round', () => {
  assert.equal(roundCrumbLabel({ candidate: { name: 'Mateo Álvarez' }, round: { id: 'r', name: 'System design', type: 'technical', minutes: 60 } }),
    'Mateo Álvarez, System design');
});

test('the footer’s time counts from the join, never from the set time, and says the round’s length before', () => {
  assert.equal(callTimeLabel(null, 60, T0), '60 min round');
  assert.equal(callTimeLabel(undefined, 45, T0), '45 min round');
  assert.equal(callTimeLabel(T0 + 5 * MIN, 60, T0), '60 min left'); // a clock skew never reads "Starts in", nor the round's length once the call is on
  assert.equal(callTimeLabel(T0, 60, T0), '60 min left');
  assert.equal(callTimeLabel(new Date(T0).toISOString(), 60, T0 + 20 * MIN), '40 min left');
  assert.equal(callTimeLabel(T0, 60, T0 + 75 * MIN), 'Over by 15 min');
  assert.equal(callTimeLabel(T0, 0, T0), null);
  for (const at of [T0, T0 + 30 * MIN, T0 + 90 * MIN]) assert.doesNotMatch(callTimeLabel(T0, 60, at) ?? '', /Starts in/);
});

test('the consent chip: every combination the staff read can carry reads as plain sentences', () => {
  const notAnswered = consentChip({ answered: false, off: ['recording', 'transcription', 'milo'] });
  assert.equal(NOT_ANSWERED_LINE, 'The candidate has not answered yet');
  assert.deepEqual(notAnswered, { label: 'Not answered yet',
    tooltip: 'The candidate has not answered yet. Until they do, nothing is recorded or transcribed and Milo cannot join the call.', tone: 'neutral' });
  // Not answered is never a refusal: no "said no", no "off", whatever the off list holds before the answers.
  assert.doesNotMatch(`${notAnswered!.label} ${notAnswered!.tooltip}`, /said no|declined|refused| off\b/i);
  assert.deepEqual(consentChip({ answered: false, off: [] }), notAnswered);
  const cases: Array<[string[], string | null, string | null]> = [
    [[], null, null],
    [['recording'], 'Recording off', 'The candidate said no to recording, so the call is not recorded.'],
    [['milo'], 'Milo off', 'The candidate said no to Milo, so Milo makes no suggestions in this call.'],
    // The server writes Milo off with the transcript; a transcript alone reads the same.
    [['transcription', 'milo'], 'No transcript or Milo', 'The candidate said no to the transcript, so nothing is transcribed and Milo cannot join the call.'],
    [['transcription'], 'No transcript or Milo', 'The candidate said no to the transcript, so nothing is transcribed and Milo cannot join the call.'],
    [['recording', 'milo'], 'Recording and Milo off', 'The candidate said no to recording, so the call is not recorded. The candidate said no to Milo, so Milo makes no suggestions in this call.'],
    [['recording', 'transcription', 'milo'], 'No recording, transcript or Milo', 'The candidate said no to recording, so the call is not recorded. The candidate said no to the transcript, so nothing is transcribed and Milo cannot join the call.'],
    [['milo', 'transcription', 'recording', 'milo'], 'No recording, transcript or Milo', 'The candidate said no to recording, so the call is not recorded. The candidate said no to the transcript, so nothing is transcribed and Milo cannot join the call.'],
  ];
  for (const [off, label, tooltip] of cases) {
    const chip = consentChip({ answered: true, off: off as Array<'recording' | 'transcription' | 'milo'> });
    if (label === null) { assert.equal(chip, null, off.join()); continue; }
    assert.deepEqual(chip, { label, tooltip, tone: 'warning' }, off.join());
    // Plain sentences: each starts with a capital and ends with a full stop; no part names or ids.
    for (const sentence of chip!.tooltip.split(/(?<=\.) /)) assert.match(sentence, /^[A-Z][^.]*\.$/);
    assert.doesNotMatch(chip!.tooltip, /transcription|interviews?:|_/);
  }
  // The longest label stays short enough for one line in the bar at 1280 (the shot measures it too).
  assert.ok(Math.max(...cases.map(([, l]) => l?.length ?? 0)) <= 32);
  assert.equal(consentChip(null), null);
  assert.equal(consentChip(undefined), null);
});

test('Milo is not offered to the lead while the candidate’s answers keep it out', () => {
  assert.deepEqual(miloInviteBlock({ answered: false, off: ['recording', 'transcription', 'milo'] }),
    { label: 'Milo waits for answers', tooltip: 'Milo can join once the candidate has answered the recording and transcript questions.' });
  assert.deepEqual(miloInviteBlock({ answered: true, off: ['transcription', 'milo'] }),
    { label: 'Milo is off', tooltip: 'The candidate said no to the transcript, so Milo cannot join this call.' });
  // Milo declined with the transcript accepted: Milo may still join to keep the transcript (no suggestions), so Invite stays.
  assert.equal(miloInviteBlock({ answered: true, off: ['milo'] }), null);
  assert.equal(miloInviteBlock({ answered: true, off: ['recording'] }), null);
  assert.equal(miloInviteBlock({ answered: true, off: [] }), null);
  assert.equal(miloInviteBlock(null), null);
});

test('before the call: the panel with the lead first, and where the candidate is', () => {
  assert.equal(panelLine([
    { person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'panel' },
    { person: { id: 'u-hugo', name: 'Hugo Marchetti' }, seat: 'lead' },
  ]), 'Hugo Marchetti (lead), Wen Zhao');
  assert.equal(panelLine([]), 'Nobody is seated yet');
  assert.equal(candidateLine(null), null);
  assert.equal(candidateLine({ state: 'not-knocked', knockedAt: null, decidedAt: null }), 'Not here yet');
  assert.equal(candidateLine({ state: 'waiting', knockedAt: 'x', decidedAt: null }), 'Waiting to be let in');
  assert.equal(candidateLine({ state: 'admitted', knockedAt: 'x', decidedAt: 'y' }), 'Let in');
  assert.equal(candidateLine({ state: 'turned-away', knockedAt: 'x', decidedAt: 'y' }), 'Asked to wait');
  // A panel member reads the same, and who lets the candidate in.
  assert.equal(candidateLine({ state: 'waiting', knockedAt: 'x', decidedAt: null }, 'panel'), 'Waiting for the lead to let them in');
  assert.equal(candidateLine({ state: 'not-knocked', knockedAt: null, decidedAt: null }, 'panel'), 'Not here yet');
});

test('the call’s tiles never show an id: the panel reads the candidate’s name, the candidate reads the lead or Interviewer', () => {
  const directory = (id: string) => (id === 'u-hugo' ? { displayName: 'Hugo Marchetti' } : null);
  const staff = staffRoomNameFor(directory, 'Nadia Petrova');
  assert.deepEqual(staff('guest:inv-e624874a'), { displayName: 'Nadia Petrova' });
  assert.deepEqual(staff('u-hugo'), { displayName: 'Hugo Marchetti' });
  assert.equal(staff('u-unknown'), null); // the directory's answer, unchanged
  assert.deepEqual(staffRoomNameFor(directory, ' ')('guest:x'), { displayName: 'Candidate' });
  assert.equal(isGuestUserId('guest:inv-1'), true);
  assert.equal(isGuestUserId('u-guest'), false);
  // One interviewer: every staff id is the lead. A panel: everyone is "Interviewer" (the guest is told only the lead's name).
  const alone = guestRoomNameFor('guest:inv-1', { lead: 'Hugo Marchetti', others: 0 });
  assert.deepEqual(alone('u-hugo'), { displayName: 'Hugo Marchetti' });
  assert.deepEqual(alone('guest:inv-1'), { displayName: 'Candidate' });
  assert.equal(alone('agent:meeting-assistant'), null);
  const panel = guestRoomNameFor('guest:inv-1', { lead: 'Wen Zhao', others: 1 });
  assert.deepEqual(panel('u-wen'), { displayName: 'Interviewer' });
  assert.deepEqual(panel('u-hugo'), { displayName: 'Interviewer' });
  assert.deepEqual(guestRoomNameFor('guest:inv-1', null)('u-wen'), { displayName: 'Interviewer' });
  for (const id of ['u-wen', 'u-hugo', 'guest:inv-1']) for (const f of [alone, panel]) assert.doesNotMatch(f(id)?.displayName ?? '', /^u-|guest:/);
});
