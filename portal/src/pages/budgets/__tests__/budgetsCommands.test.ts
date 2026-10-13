import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initiativeBudgetsCommandAdapter, matchesBudget, matchesGrant, sprintEnvelopesCommandAdapter } from '../budgetsCommands.ts';

const BUDGETS = [
  { orgProjectId: 'p-auth-migration', orgProjectName: 'Auth migration' },
  { orgProjectId: 'p-soc2', orgProjectName: null },
];

test('budgets: matchers cover the visible columns', () => {
  assert.ok(matchesBudget(BUDGETS[0], 'auth'));
  assert.ok(matchesBudget(BUDGETS[1], 'soc2'));
  assert.ok(matchesGrant({ orgProjectName: 'RAG search', sprintName: 'Sprint 14', granteeName: 'Priya' }, 'priya'));
  assert.ok(!matchesGrant({ orgProjectName: null, sprintName: null, granteeName: null }, 'x'));
});

test('initiative budgets: examples run; allocation edits are refused; open is exact on current rows', async () => {
  let query = 'q'; let refreshes = 0; let opened = '';
  const adapter = initiativeBudgetsCommandAdapter({ setQuery: v => { query = v; }, refresh: () => { refreshes++; }, rows: BUDGETS, open: id => { opened = id; } });
  for (const text of ['set budget for Auth migration to 500', 'remove allocation p-soc2', 'show blind spot initiatives', 'open all']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(text)), text);
  }
  assert.equal(query, 'q'); assert.equal(refreshes, 0); assert.equal(opened, '');
  for (const example of adapter.examples.filter(e => !e.startsWith('open <'))) await adapter.execute(example);
  assert.equal(refreshes, 1);
  await adapter.execute('open auth MIGRATION'); assert.equal(opened, 'p-auth-migration');
  await adapter.execute('open p-soc2'); assert.equal(opened, 'p-soc2');
  await assert.rejects(() => Promise.resolve(adapter.execute('open Auth')), /No matching/);
});

test('sprint envelopes: search and refresh only; no open, no grant', async () => {
  let query = 'q'; let refreshes = 0;
  const adapter = sprintEnvelopesCommandAdapter({ setQuery: v => { query = v; }, refresh: () => { refreshes++; } });
  await assert.rejects(() => Promise.resolve(adapter.execute('open Sprint 14')), /not available/);
  await assert.rejects(() => Promise.resolve(adapter.execute('grant envelope to Priya')));
  assert.equal(query, 'q'); assert.equal(refreshes, 0);
  await adapter.execute('search sprints for "Sprint 14"'); assert.equal(query, 'Sprint 14');
  await adapter.execute('refresh sprints'); assert.equal(refreshes, 1);
  assert.ok(!adapter.examples.some(e => e.startsWith('open ')));
});
