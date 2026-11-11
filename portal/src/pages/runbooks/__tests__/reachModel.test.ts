import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REACH_EMPTY, outcomeLabel, reachEmpty, reachItemName, reachNote, reachTitle, type ProposalReach } from '../reachModel.ts';

const base: ProposalReach = { mode: 'receive', items: [], total: 0, scanned: 0, capped: false };

test('an empty reach says so in plain words', () => {
  assert.equal(reachEmpty(base), REACH_EMPTY);
  assert.equal(REACH_EMPTY, 'No open work item would be given this runbook today.');
});

test('the heading follows what the proposal does', () => {
  assert.equal(reachTitle(base), 'Would be given to');
  assert.equal(reachTitle({ ...base, mode: 'lose' }), 'Would lose it');
  assert.equal(reachTitle({ ...base, mode: 'gain' }), 'Would gain it');
});

test('the note names a cut list and a capped scan, and is silent otherwise', () => {
  assert.equal(reachNote(base), null);
  const item = { id: 'a', key: 'K-1', title: 't', initiative: { id: 'p', name: 'P' }, outcome: 'chosen' as const };
  assert.match(reachNote({ ...base, items: [item], total: 31 })!, /Showing 1 of 31 open work items\./);
  assert.match(reachNote({ ...base, capped: true, scanned: 200 })!, /Only the 200 most recently updated open work items were checked/);
});

test('a row is named by key and title, and a limit loss is explained', () => {
  assert.equal(reachItemName({ id: 'a', key: 'K-1', title: 'Cut over', initiative: { id: 'p', name: 'P' }, outcome: 'chosen' }), 'K-1 Cut over');
  assert.equal(reachItemName({ id: 'a', key: null, title: 'Cut over', initiative: { id: 'p', name: 'P' }, outcome: 'chosen' }), 'Cut over');
  assert.equal(outcomeLabel('chosen'), 'Given');
  assert.match(outcomeLabel('passed_over'), /Passed over/);
});
