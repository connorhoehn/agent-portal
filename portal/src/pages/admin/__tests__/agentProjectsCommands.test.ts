import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codebasesCommandAdapter, matchesCodebase } from '../agentProjectsCommands.ts';

const ROWS = [
  { id: 'ap-1', repoFullName: 'acme/auth-service', orgProjectName: 'Auth migration', owners: [{ name: 'Priya' }] },
  { id: 'ap-2', repoFullName: 'acme/rag-search', orgProjectName: null, owners: [] },
];

test('codebases: search matches repository, initiative and owner', () => {
  assert.ok(matchesCodebase(ROWS[0], 'AUTH-serv'));
  assert.ok(matchesCodebase(ROWS[0], 'migration'));
  assert.ok(matchesCodebase(ROWS[0], 'priya'));
  assert.ok(!matchesCodebase(ROWS[1], 'priya'));
  assert.ok(matchesCodebase(ROWS[1], '  '));
});

test('codebases: examples execute; link/clone/run phrases and filters change nothing; open focuses exactly', async () => {
  let query = 'q'; let refreshes = 0; let focused = '';
  const adapter = codebasesCommandAdapter({ setQuery: v => { query = v; }, refresh: () => { refreshes++; }, rows: ROWS, focus: id => { focused = id; } });
  for (const text of ['clone acme/auth-service', 'unlink ap-1', 'run a task', 'show private codebases', 'open everything']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(text)), text);
  }
  assert.equal(query, 'q'); assert.equal(refreshes, 0); assert.equal(focused, '');
  await adapter.execute('search codebases for "rag"'); assert.equal(query, 'rag');
  await adapter.execute('clear search'); assert.equal(query, '');
  await adapter.execute('refresh codebases'); assert.equal(refreshes, 1);
  await adapter.execute('open ACME/RAG-SEARCH'); assert.equal(focused, 'ap-2');
  await adapter.execute('open ap-1'); assert.equal(focused, 'ap-1');
  await assert.rejects(() => Promise.resolve(adapter.execute('open acme')), /No matching/);
});
