// Preparing a round, the portal's pure helpers (lib/interviewsPrepare.ts, row I1.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bankGroups, canOpenRoom, preparePath, roomPath, samePlan } from '../interviewsPrepare.ts';

const q = (id: string, competencyId: string, competency: string) => ({ id, prompt: id, competencyId, competency, hasStarter: false });

test('the bank groups by competency in the kit\'s order and leaves out what the plan already holds', () => {
  const bank = [q('a', 'c2', 'Two'), q('b', 'c1', 'One'), q('c', 'c2', 'Two')];
  const groups = bankGroups(bank, [{ id: 'c1' }, { id: 'c2' }], ['c']);
  assert.deepEqual(groups.map((g) => [g.name, g.questions.map((x) => x.id)]), [['One', ['b']], ['Two', ['a']]]);
});

test('the room opens for a seat on a ready or live round only', () => {
  assert.equal(canOpenRoom({ state: 'ready', seat: 'lead' }), true);
  assert.equal(canOpenRoom({ state: 'live', seat: 'panel' }), true);
  assert.equal(canOpenRoom({ state: 'accepted', seat: 'lead' }), false);
  assert.equal(canOpenRoom({ state: 'ready', seat: null }), false);
});

test('paths and plan comparison', () => {
  assert.equal(preparePath('iv 1'), '/interviews/rounds/iv%201/prepare');
  assert.equal(roomPath('iv-1'), '/interviews/rounds/iv-1/room');
  assert.equal(samePlan(['a', 'b'], ['a', 'b']), true);
  assert.equal(samePlan(['a', 'b'], ['b', 'a']), false);
});
