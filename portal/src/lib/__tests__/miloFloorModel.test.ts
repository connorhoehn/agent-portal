import test from 'node:test';
import assert from 'node:assert/strict';
import { floorHighlightFor, holdRefusalWords, miloChannel } from '../miloFloorModel.ts';

test('the tile ring marks only whoever has the floor, for every viewer', () => {
  assert.equal(floorHighlightFor(null), undefined);
  const ring = floorHighlightFor({ userId: 'u-hugo' })!;
  assert.deepEqual(ring('u-hugo'), { label: 'Talking to Milo' });
  assert.equal(ring('u-una'), undefined);
});

test('the floor rides the call chat channel', () => {
  assert.equal(miloChannel('c-1'), 'orgiq:huddle:c-1');
});

test('a refused press says the server\'s sentence, or a plain one', () => {
  assert.equal(holdRefusalWords(409, { error: 'Someone else is talking to Milo. Try again when they finish.' }), 'Someone else is talking to Milo. Try again when they finish.');
  assert.match(holdRefusalWords(409, null), /Someone else/);
  assert.match(holdRefusalWords(500, {}), /could not/);
});
