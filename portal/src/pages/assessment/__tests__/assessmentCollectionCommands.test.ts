// Run with:  cd portal && node --test 'src/pages/assessment/__tests__/assessmentCollectionCommands.test.ts'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  feedbackCommandAdapter, reportsCommandAdapter, submissionsCommandAdapter, teamsCommandAdapter,
} from '../assessmentCollectionCommands.ts';

const TEAMS = [{ id: 'TEAM-001', name: 'Payments' }, { id: 'TEAM-002', name: 'Search' }, { id: 'TEAM-003', name: 'search' }];

function teamsHarness(rows = TEAMS) {
  const calls: string[] = [];
  const adapter = teamsCommandAdapter(rows, {
    setQuery: (v) => calls.push(`query:${v}`),
    setMotion: (v) => calls.push(`motion:${v}`),
    clearStatus: () => calls.push('status:all'),
    refresh: () => calls.push('refresh'),
    openTeam: (id) => calls.push(`open:${id}`),
  });
  return { adapter, calls };
}

test('teams: advertised examples drive the desk state', async () => {
  const { adapter, calls } = teamsHarness();
  for (const example of adapter.examples) {
    if (example.startsWith('open ')) continue;
    await adapter.execute(example);
  }
  assert.deepEqual(calls, [
    'query:name', 'motion:white_glove', 'motion:self_service', 'motion:general',
    'query:', 'motion:all', 'status:all', 'refresh',
  ]);
});

test('teams: open resolves exact ID or unique name on the current rows only', async () => {
  const { adapter, calls } = teamsHarness();
  await adapter.execute('open TEAM-001');
  await adapter.execute('open payments');
  assert.deepEqual(calls, ['open:TEAM-001', 'open:TEAM-001']);
  await assert.rejects(async () => adapter.execute('open search'), /multiple/);
  await assert.rejects(async () => adapter.execute('open team-001'), /No matching/);
  await assert.rejects(async () => adapter.execute('open Pay'), /No matching/);
  await assert.rejects(async () => adapter.execute('open all'), /exact ID/);
  const filtered = teamsHarness(TEAMS.slice(1));
  await assert.rejects(async () => filtered.adapter.execute('open TEAM-001'), /No matching/);
  assert.equal(calls.length, 2);
});

test('teams: mutations and unknown phrases change nothing', async () => {
  const { adapter, calls } = teamsHarness();
  for (const text of ['create team Payments', 'delete TEAM-001', 'score all teams', 'show assessed teams', 'new team']) {
    await assert.rejects(async () => adapter.execute(text), /No changes were made/);
  }
  assert.deepEqual(calls, []);
});

test('submissions: search, reset and refresh only; no open, no deletion', async () => {
  const calls: string[] = [];
  const adapter = submissionsCommandAdapter({ setQuery: (v) => calls.push(`query:${v}`), refresh: () => calls.push('refresh') });
  await adapter.execute('search submissions for "Form #12"');
  await adapter.execute('clear filters');
  await adapter.execute('reload');
  assert.deepEqual(calls, ['query:Form #12', 'query:', 'refresh']);
  await assert.rejects(async () => adapter.execute('open TEAM-001'), /not available/);
  for (const text of ['delete all submissions', 'clear selected', 'add submissions', 'show unprocessed submissions']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 3);
  assert.ok(!adapter.examples.some((e) => e.startsWith('open ')));
});

test('reports: heatmap search and motion only; publishing is not a command', async () => {
  const calls: string[] = [];
  const adapter = reportsCommandAdapter({
    setQuery: (v) => calls.push(`query:${v}`), setMotion: (v) => calls.push(`motion:${v}`), refresh: () => calls.push('refresh'),
  });
  await adapter.execute('find Payments');
  await adapter.execute('show general teams');
  await adapter.execute('reset');
  assert.deepEqual(calls, ['query:Payments', 'motion:general', 'query:', 'motion:all']);
  for (const text of ['publish report', 'publish the report', 'open TEAM-001', 'show claims open']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 4);
});

test('feedback: status phrases, reset to the open queue, exact open', async () => {
  const calls: string[] = [];
  const rows = [{ task_id: 'fb-1', question: 'Where is the runbook?' }, { task_id: 'fb-2', question: 'Who owns on-call?' }];
  const adapter = feedbackCommandAdapter(rows, {
    setQuery: (v) => calls.push(`query:${v}`), setStatus: (v) => calls.push(`status:${v}`), clearTeam: () => calls.push('team:all'),
    refresh: () => calls.push('refresh'), openQuestion: (id) => calls.push(`open:${id}`),
  });
  await adapter.execute('show answered questions');
  await adapter.execute('filter any status');
  await adapter.execute('clear all filters');
  await adapter.execute('open fb-2');
  await adapter.execute('open "where is the runbook?"');
  assert.deepEqual(calls, ['status:RESOLVED', 'status:ALL', 'query:', 'status:OPEN', 'team:all', 'open:fb-2', 'open:fb-1']);
  for (const text of ['answer fb-1', 'dismiss fb-1', 'resolve all questions', 'open fb']) {
    await assert.rejects(async () => adapter.execute(text));
  }
  assert.equal(calls.length, 7);
});
