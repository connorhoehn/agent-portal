import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRows } from '../useRowSearch.ts';

const rows = [
  { id: 'TEAM-001', name: 'Kubernetes Operator' },
  { id: 'TEAM-002', name: 'Payments API' },
];
const text = (r: (typeof rows)[number]) => `${r.id} ${r.name}`;

test('an empty query keeps every row', () => {
  assert.deepEqual(filterRows(rows, '  ', text), rows);
});

test('every term must match, case-insensitively', () => {
  assert.deepEqual(filterRows(rows, 'team kube', text).map((r) => r.id), ['TEAM-001']);
  assert.deepEqual(filterRows(rows, 'PAYMENTS', text).map((r) => r.id), ['TEAM-002']);
  assert.deepEqual(filterRows(rows, 'payments kube', text), []);
});
