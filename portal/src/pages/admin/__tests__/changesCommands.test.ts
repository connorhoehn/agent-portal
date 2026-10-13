import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesCommandAdapter, matchesChange } from '../changesCommands.ts';

const ROWS = [
  { id: 'chg-1', title: 'Add health check', repoFullName: 'acme/api', orgProjectName: 'Reliability' },
  { id: 'chg-2', title: 'Bump deps', repoFullName: null, orgProjectName: null },
];

test('changes: search covers title, codebase and initiative', () => {
  assert.ok(matchesChange(ROWS[0], 'acme/api'));
  assert.ok(matchesChange(ROWS[0], 'reliab'));
  assert.ok(!matchesChange(ROWS[1], 'acme'));
});

test('changes: decisions are never commands; search/refresh/open are', async () => {
  let query = 'q'; let refreshes = 0; let opened = '';
  const adapter = changesCommandAdapter({ setQuery: v => { query = v; }, refresh: () => { refreshes++; }, rows: ROWS, open: id => { opened = id; } });
  for (const text of ['approve chg-1', 'reject all', 'deliver Add health check', 're-review chg-1', 'show approved changes', 'open selected']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(text)), text);
  }
  assert.equal(query, 'q'); assert.equal(refreshes, 0); assert.equal(opened, '');
  for (const example of adapter.examples.filter(e => !e.startsWith('open <'))) await adapter.execute(example);
  assert.equal(refreshes, 1);
  await adapter.execute('search changes for "health"'); assert.equal(query, 'health');
  await adapter.execute('open "add HEALTH check"'); assert.equal(opened, 'chg-1');
  await adapter.execute('open chg-2'); assert.equal(opened, 'chg-2');
  await assert.rejects(() => Promise.resolve(adapter.execute('open CHG-2')), /No matching/);
});
