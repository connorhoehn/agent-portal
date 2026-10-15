import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter } from '../../../components/collections/collectionCommands.ts';
import { DECISION_GRAMMAR } from '../decisionCommands.ts';
import { asInstant, filterDecisions, historyOf, matchesDecision, sortDecisions, standingLine } from '../decisionFormat.ts';
import type { DecisionDetail } from '../types';

const person = (personId: string, name: string, role: string) => ({ personId, name, title: null, role, weight: 1 });
const detail = (status: string, decidedAt: string | null = null): DecisionDetail => ({
  id: 'd-1', topic: 'Cutover order', summary: 'x', status, projectId: 'p-1', decidedAt,
  participants: [person('p-2', 'Nora', 'contributor'), person('p-5', 'Sienna Garcia', 'decider')],
});

test('waiting decisions sort first, then settled newest first', () => {
  const rows = [
    { id: 'a', status: 'resolved', decidedAt: '2026-01-01', topic: 'A' },
    { id: 'b', status: 'open', decidedAt: null, topic: 'B' },
    { id: 'c', status: 'resolved', decidedAt: '2026-03-01', topic: 'C' },
    { id: 'd', status: 'escalated', decidedAt: null, topic: 'D' },
  ];
  assert.deepEqual(sortDecisions(rows).map((r) => r.id), ['d', 'b', 'c', 'a']);
  assert.deepEqual(filterDecisions(rows, 'waiting').map((r) => r.id), ['b', 'd']);
  assert.equal(filterDecisions(rows, 'all').length, 4);
});

test('a DATE column becomes an instant; search reads topic, summary and initiative', () => {
  assert.equal(asInstant('2026-03-12'), '2026-03-12T12:00:00Z');
  assert.equal(asInstant('2026-03-12T01:00:00Z'), '2026-03-12T01:00:00Z');
  assert.equal(matchesDecision({ id: 'd-1', topic: 'Cutover', summary: null }, 'auth', 'Auth Migration'), true);
  assert.equal(matchesDecision({ id: 'd-1', topic: 'Cutover', summary: null }, 'zzz'), false);
});

test('the standing line names the decider, never an id', () => {
  const rel = (iso: string) => `rel(${iso})`;
  assert.equal(standingLine({ ...detail('escalated'), escalatedAt: 'T', requiredRole: 'org-leader' }, 'Sienna Garcia', rel), 'Waiting on Sienna Garcia, escalated rel(T)');
  assert.equal(standingLine({ ...detail('escalated'), requiredRole: 'org-leader' }, null, rel), 'Waiting on the org-leader');
  assert.equal(standingLine(detail('resolved', '2026-03-12'), 'Sienna Garcia', rel), 'Decided by Sienna Garcia rel(2026-03-12T12:00:00Z)');
});

test('history: raised last, escalation and the settling call before it', () => {
  const ev = historyOf(detail('resolved', '2026-03-12'), { id: 'd-1', requiredRole: 'org-leader', escalatedAt: 'E', workItemId: null, workItemTitle: null }, 'Auth Migration');
  assert.deepEqual(ev.map((e) => e.id), ['settled', 'escalated', 'raised']);
  assert.match(ev[0]!.detail, /Sienna Garcia/);
  assert.equal(historyOf(detail('open'), null, null).at(-1)!.detail, 'Raised as an organisation-wide call.');
});

test('decisions grammar: status phrases and search; no decide verbs', async () => {
  const state = { query: '', status: 'all' };
  const adapter = collectionCommandAdapter(DECISION_GRAMMAR, {
    setQuery: (v) => { state.query = v; }, setFilter: (v) => { state.status = v || 'all'; }, refresh: () => {}, scopeNote: 'x',
  });
  await adapter.execute('show waiting decisions'); assert.equal(state.status, 'waiting');
  await adapter.execute('show decided decisions'); assert.equal(state.status, 'resolved');
  await adapter.execute('search decisions for cutover'); assert.equal(state.query, 'cutover');
  for (const bad of ['decide d-1', 'escalate everything', 'approve all decisions']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(bad)), bad);
  }
});
