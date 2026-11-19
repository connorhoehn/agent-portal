import test from 'node:test';
import assert from 'node:assert/strict';
import { busyLabel, floorWords, holdRefusalWords, parseFloor } from '../miloFloorModel.ts';

const hugo = { handsfree: true, floor: { userId: 'u-hugo', name: 'Hugo', via: 'hold', phase: 'routing' } };

test('a floor body reads who is talking to Milo; anything odd is nobody', () => {
  assert.deepEqual(parseFloor(hugo), { handsfree: true, floor: { userId: 'u-hugo', name: 'Hugo', via: 'hold', phase: 'routing' } });
  for (const body of [null, 'x', [], {}, { handsfree: true, floor: { userId: 'u', name: '', via: 'hold', phase: 'routing' } }, { handsfree: true, floor: { userId: 'u', name: 'U', via: 'shout', phase: 'routing' } }]) {
    assert.equal(parseFloor(body).floor, null);
  }
  // Not hands-free: no floor even if one is sent.
  assert.equal(parseFloor({ ...hugo, handsfree: false }).floor, null);
  assert.equal(parseFloor({ handsfree: true, floor: null, mayHold: true }).mayHold, true);
});

test('"Hugo is talking to Milo" for every viewer, "You are" for Hugo, nothing when nobody holds the floor', () => {
  const v = parseFloor(hugo);
  assert.equal(floorWords(v, 'u-una'), 'Hugo is talking to Milo');
  assert.equal(floorWords(v, 'u-hugo'), 'You are talking to Milo');
  assert.equal(floorWords(parseFloor({ handsfree: true, floor: null }), 'u-una'), null);
});

test('the button is busy only for someone other than the holder', () => {
  const v = parseFloor(hugo);
  assert.deepEqual(busyLabel(v, 'u-una'), { label: 'Hugo is talking to Milo' });
  assert.equal(busyLabel(v, 'u-hugo'), undefined);
});

test('a refused press says the server\'s sentence, or a plain one', () => {
  assert.equal(holdRefusalWords(409, { error: 'Someone else is talking to Milo. Try again when they finish.' }), 'Someone else is talking to Milo. Try again when they finish.');
  assert.match(holdRefusalWords(409, null), /Someone else/);
  assert.match(holdRefusalWords(500, {}), /could not/);
});
