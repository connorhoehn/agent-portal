import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchCommand } from '../searchCommands.ts';
const agents = [{ id: 'orgiq-supervisor', name: 'Supervisor' }, { id: 'orgiq-search', name: 'Search Agent' }];
test('ordinary questions use automatic routing', () => { assert.deepEqual(parseSearchCommand('Who can help?', agents), { text: 'Who can help?' }); });
test('explicit agent IDs and picker names route only to the current roster', () => {
  assert.equal(parseSearchCommand('/agent orgiq-search Who owns Auth?', agents).agentId, 'orgiq-search');
  assert.equal(parseSearchCommand('/agent Search Agent Who owns Auth?', agents, 'orgiq-search').text, 'Who owns Auth?');
});
test('unknown, absent, incomplete and stale commands keep the draft with an error', () => {
  for (const value of ['/shell rm', '/agent missing question', '/agent', '/agent Supervisor']) assert.ok(parseSearchCommand(value, agents).error);
  assert.ok(parseSearchCommand('/agent Search Agent Who?', agents.slice(0, 1), 'orgiq-search').error);
});
test('ambiguous labels require an ID, selected exact IDs disambiguate', () => {
  const duplicate = [...agents, { id: 'other-search', name: 'Search Agent' }];
  assert.ok(parseSearchCommand('/agent Search Agent Who?', duplicate).error);
  assert.equal(parseSearchCommand('/agent Search Agent Who?', duplicate, 'other-search').agentId, 'other-search');
});
