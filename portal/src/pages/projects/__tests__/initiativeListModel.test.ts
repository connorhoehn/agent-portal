// Run with:  cd portal && node --test 'src/pages/projects/__tests__/*.test.ts'
//
// The explorer rail: groups and counts from rows, title-only rows (v2 V6),
// "N+" on a capped page, and a failed read as a state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildInitiativeList, countLabel, railEmptyCopy } from '../initiativeListModel.ts';
import type { ProjectSummary } from '../types.ts';

function p(id: string, status: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  return { id, name: id, status, contributorCount: 1, createdAt: null, ...extra };
}

const rows: ProjectSummary[] = [
  p('Observability Platform', 'in_progress', { id: 'p-observability', ownerName: 'Nora DaSilva', activeAgentRuns: 2 }),
  p('ML Feature Store', 'in_progress', { ownerName: 'Vera Petrov', activeAgentRuns: 0 }),
  p('Auth Migration', 'active', { ownerName: 'Vera Green', activeAgentRuns: 1 }),
  p('Data Lake Migration', 'planning', { ownerName: 'Ben', activeAgentRuns: null }),
  p('Legacy', 'completed', { id: 'p-legacy' }),
];

test('rows are title-only: v2 dropped the "Owner · N agents" subline (V6)', () => {
  const m = buildInitiativeList({ rows, scope: 'all' });
  assert.equal(m.state, 'ready');
  if (m.state !== 'ready') return;
  const row = m.groups[0].rows.find((r) => r.id === 'p-observability');
  assert.deepEqual(Object.keys(row ?? {}).sort(), ['groupId', 'href', 'id', 'title']);
});

test('groups by status with counts from rows: In progress open, the rest collapsed', () => {
  const m = buildInitiativeList({ rows, scope: 'all' });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.deepEqual(m.groups.map((g) => [g.title, g.count, g.defaultOpen]), [
    ['In progress', 3, true], ['Planning', 1, false], ['Completed', 1, false],
  ]);
  // Live activity first; active reads as in progress.
  assert.deepEqual(m.groups[0]!.rows.map((r) => r.title), ['Observability Platform', 'Auth Migration', 'ML Feature Store']);
  assert.equal(m.groups[0]!.rows[0]!.href, '/iq/projects/p-observability');
  assert.equal(m.count, '5');
  assert.equal(m.footer, '5 initiatives');
});

test('the group holding the open initiative opens', () => {
  const m = buildInitiativeList({ rows, scope: 'all', currentId: 'p-legacy' });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.equal(m.groups.find((g) => g.id === 'completed')!.defaultOpen, true);
});

test('a full capped page reads "N+" in the header and footer', () => {
  assert.equal(countLabel(100, true), '100+');
  const m = buildInitiativeList({ rows, scope: 'all', limit: 5 });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.equal(m.count, '5+');
  assert.equal(m.footer, '5+ initiatives');
});

test('search narrows groups and the footer says "N of M"; no hits is no-match, not empty', () => {
  const m = buildInitiativeList({ rows, scope: 'all', query: 'vera' });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.equal(m.shown, 2);
  assert.equal(m.footer, '2 of 5 initiatives');
  assert.equal(m.count, '5');
  assert.equal(buildInitiativeList({ rows, scope: 'all', query: 'zzz' }).state, 'no-match');
  const planning = buildInitiativeList({ rows, scope: 'all', statusFilter: 'planning' });
  assert.equal(planning.state === 'ready' && planning.shown, 1);
});

test('empty Mine reads "Personal view"; a failed read is an error, never empty copy', () => {
  const mine = buildInitiativeList({ rows: [], scope: 'mine' });
  assert.equal(mine.state, 'empty');
  assert.equal(mine.footer, 'Personal view');
  assert.equal(mine.count, '0');
  assert.equal(buildInitiativeList({ rows: [], scope: 'all' }).footer, '0 initiatives');
  const failed = buildInitiativeList({ rows: [], error: 'HTTP 500', scope: 'mine' });
  assert.equal(failed.state, 'error');
  assert.equal(failed.footer, null);
  assert.equal(buildInitiativeList({ rows: undefined, scope: 'all' }).state, 'loading');
  assert.deepEqual(railEmptyCopy('mine'), { title: 'Nothing linked yet', body: 'Try All initiatives to browse the workspace.', action: { label: 'Show all initiatives' } });
});
