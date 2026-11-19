// The room's call states (docked pane, floating gallery, minimised pill): every state and every switch between them
// leaves the call's media exactly one holder, so the remote voices never lose their element; the choice is remembered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_CALL_MODES, parseRoomCallMode, roomCallActions, roomCallClaims, roomCallSink, type RoomCallMode } from '../roomCallMode.ts';

test('each state has exactly one media holder: a page block claims it, or the shell outlet holds it', () => {
  assert.equal(roomCallSink('docked'), 'pane');
  assert.equal(roomCallSink('floating'), 'gallery');
  assert.equal(roomCallSink('minimised'), 'outlet');
  for (const m of ROOM_CALL_MODES) {
    const holders = roomCallClaims(m) + (roomCallSink(m) === 'outlet' ? 1 : 0);
    assert.equal(holders, 1, `${m} has ${holders} holders`);
  }
});

test('every switch a header offers lands on a state with a holder, and the three states reach each other', () => {
  const reached = new Set<RoomCallMode>(['floating']);
  const queue: RoomCallMode[] = ['floating'];
  while (queue.length) {
    const from = queue.shift()!;
    for (const a of roomCallActions(from)) {
      assert.notEqual(a.to, from);
      assert.ok(roomCallSink(a.to), `${from} -> ${a.to} has no holder`);
      if (!reached.has(a.to)) { reached.add(a.to); queue.push(a.to); }
    }
  }
  assert.deepEqual([...reached].sort(), [...ROOM_CALL_MODES].sort());
});

test('the headers are labelled as the owner asked; the pill restores to floating', () => {
  assert.deepEqual(roomCallActions('floating').map((a) => a.label), ['Dock the call', 'Minimise']);
  assert.deepEqual(roomCallActions('docked').map((a) => a.label), ['Float the call', 'Minimise']);
  assert.deepEqual(roomCallActions('minimised').map((a) => a.to), ['floating']);
});

test('a stored choice is kept; anything else falls back (technical rounds float by default)', () => {
  assert.equal(parseRoomCallMode('docked', 'floating'), 'docked');
  assert.equal(parseRoomCallMode('minimised', 'floating'), 'minimised');
  assert.equal(parseRoomCallMode(null, 'floating'), 'floating');
  assert.equal(parseRoomCallMode('1', 'floating'), 'floating');
  assert.equal(parseRoomCallMode(undefined, 'docked'), 'docked');
});
