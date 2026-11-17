// The room as decision 21 draws it (UI round 1, lane ROOM): the pane's tabs (U1), the round's crumb (U6), the
// footer's time and consent chip, and the facts shown before the call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NOT_ANSWERED_LINE, ROOM_MESSAGE_TAB, callTimeLabel, candidateLine, consentChip, defaultRoomTab, panelLine, roomPaneWidth,
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
  assert.deepEqual(roomPaneWidth('technical'), { min: 560, max: 760 });
  assert.deepEqual(roomPaneWidth('behavioural'), { min: 360, max: 460 });
});

test('the round’s crumb names the candidate, then the round', () => {
  assert.equal(roundCrumbLabel({ candidate: { name: 'Mateo Álvarez' }, round: { id: 'r', name: 'System design', type: 'technical', minutes: 60 } }),
    'Mateo Álvarez, System design');
});

test('the footer’s time counts from the join, never from the set time, and says the round’s length before', () => {
  assert.equal(callTimeLabel(null, 60, T0), '60 min round');
  assert.equal(callTimeLabel(undefined, 45, T0), '45 min round');
  assert.equal(callTimeLabel(T0 + 5 * MIN, 60, T0), '60 min round'); // a clock skew never reads "Starts in"
  assert.equal(callTimeLabel(T0, 60, T0), '60 min left');
  assert.equal(callTimeLabel(new Date(T0).toISOString(), 60, T0 + 20 * MIN), '40 min left');
  assert.equal(callTimeLabel(T0, 60, T0 + 75 * MIN), 'Over by 15 min');
  assert.equal(callTimeLabel(T0, 0, T0), null);
  for (const at of [T0, T0 + 30 * MIN, T0 + 90 * MIN]) assert.doesNotMatch(callTimeLabel(T0, 60, at) ?? '', /Starts in/);
});

test('the consent chip: not answered yet until the answers exist, then what is off, then nothing', () => {
  assert.deepEqual(consentChip({ answered: false, off: ['recording', 'transcription', 'milo'] }),
    { label: 'Not answered yet', tooltip: `${NOT_ANSWERED_LINE}.`, tone: 'neutral' });
  assert.equal(NOT_ANSWERED_LINE, 'The candidate has not answered yet');
  assert.deepEqual(consentChip({ answered: true, off: ['recording'] }),
    { label: 'Recording off', tooltip: 'Recording is off for this interview.', tone: 'warning' });
  assert.deepEqual(consentChip({ answered: true, off: ['transcription', 'milo'] }),
    { label: '2 parts off', tooltip: 'Transcription and Milo are off for this interview.', tone: 'warning' });
  assert.equal(consentChip({ answered: true, off: [] }), null);
  assert.equal(consentChip(null), null);
  assert.equal(consentChip(undefined), null);
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
});
