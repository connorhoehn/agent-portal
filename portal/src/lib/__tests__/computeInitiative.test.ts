// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Computer } from '@connorhoehn/ui-components/compute';

import { computersForInitiative, truncateTask } from '../computeInitiative.ts';

function computer(overrides: Partial<Computer> & Pick<Computer, 'id'>): Computer {
  return {
    label: overrides.id,
    sessionId: `sess-${overrides.id}-000000000000000000000000000`,
    createdAt: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

test('only computers charged to this initiative are returned', () => {
  const computers = [
    computer({ id: 'a', projectId: 'p-1' }),
    computer({ id: 'b', projectId: 'p-2' }),
    computer({ id: 'c', projectId: 'p-1' }),
  ];
  const result = computersForInitiative(computers, 'p-1');
  assert.deepEqual(result.map((c) => c.id), ['a', 'c']);
});

test('no initiative id yields no computers', () => {
  const computers = [computer({ id: 'a', projectId: 'p-1' })];
  assert.deepEqual(computersForInitiative(computers, undefined), []);
});

test('running computers sort first, then by most recent activity', () => {
  const computers = [
    computer({ id: 'idle-old', projectId: 'p-1', status: 'idle', lastActivityAt: '2026-08-01T00:00:00Z' }),
    computer({ id: 'running', projectId: 'p-1', status: 'running', lastActivityAt: '2026-07-01T00:00:00Z' }),
    computer({ id: 'idle-new', projectId: 'p-1', status: 'stopped', lastActivityAt: '2026-08-15T00:00:00Z' }),
  ];
  const result = computersForInitiative(computers, 'p-1');
  assert.deepEqual(result.map((c) => c.id), ['running', 'idle-new', 'idle-old']);
});

test('task text under the limit passes through untouched', () => {
  assert.equal(truncateTask('fix the flaky test'), 'fix the flaky test');
});

test('task text over the limit is ellipsized to the max length', () => {
  const long = 'x'.repeat(80);
  const result = truncateTask(long, 60);
  assert.equal(result!.length, 60);
  assert.ok(result!.endsWith('…'));
});

test('no task text returns null', () => {
  assert.equal(truncateTask(undefined), null);
  assert.equal(truncateTask(''), null);
  assert.equal(truncateTask('   '), null);
});
