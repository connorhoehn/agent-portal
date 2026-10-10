import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDay, documentKind, logLines, maintenanceFact, workspaceDocuments,
} from '../initiativePaneModel.ts';

test('the maintenance floor is the server\'s value; unknown is said, never summed to zero', () => {
  const money = (n: number) => `$${n.toFixed(2)}`;
  assert.deepEqual(maintenanceFact({ loading: false, error: null, floor: { cronRuns: 3, costUsd: 0.2 } }, money), { value: '$0.20 · 3 cron runs, last 30 days', muted: false });
  assert.deepEqual(maintenanceFact({ loading: false, error: null, floor: { cronRuns: 1, costUsd: 0 } }, money, true), { value: '$0.00 · 1 cron run, 30d', muted: false });
  assert.deepEqual(maintenanceFact({ loading: true, error: null, floor: undefined }, money), { value: 'Loading…', muted: true });
  assert.deepEqual(maintenanceFact({ loading: false, error: 'boom', floor: undefined }, money), { value: 'Runs could not be read', muted: true });
  // The server could not read v_initiative_maintenance_30d: not known, not $0.
  assert.deepEqual(maintenanceFact({ loading: false, error: null, floor: null }, money), { value: 'Maintenance not known', muted: true });
});

test('workspace documents: once each, governance kinds first', () => {
  const docs = workspaceDocuments([
    [{ id: 'slack-p-auth-00', title: '#proj-auth — library choices', source: null },
      { id: 'postmortem-p-auth-migration', title: 'Postmortem: token cache race', source: null }],
    [{ id: 'adr-d-aurora', title: 'ADR: Adopt Aurora over Neptune', source: null },
      { id: 'slack-p-auth-00', title: '#proj-auth — library choices', source: null }],
  ]);
  assert.deepEqual(docs.map((d) => d.id), ['adr-d-aurora', 'postmortem-p-auth-migration', 'slack-p-auth-00']);
  assert.equal(documentKind({ id: 'charter-auth', title: null }).label, 'Charter');
  assert.equal(documentKind({ id: 'doc-9', title: 'Runbook: rotate keys' }).label, 'Runbook');
  assert.equal(documentKind({ id: 'perf-p-008', title: 'Perf Review' }).label, 'Document');
});

test('log lines: the transcript when kept, else tool calls, then the outcome', () => {
  assert.deepEqual(logLines({ status: 'done', error: null, result: { summary: 'completed.', toolCallList: [{ name: 'read_file', done: true }] } })
    .map((l) => `${l.label}:${l.text}`), ['read_file:done', 'outcome:completed.']);
  assert.deepEqual(logLines({ status: 'failed', error: 'boom', result: { transcript: [{ t: 'text', detail: 'hi' }] } })
    .map((l) => l.kind), ['text', 'error']);
});

test('a calendar DATE reads as its own day', () => {
  assert.equal(calendarDay('2026-10-01'), 'Oct 1, 2026');
  assert.equal(calendarDay(null), null);
  assert.equal(calendarDay('not a date'), null);
});
