import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter } from '../../../components/collections/collectionCommands.ts';
import { DECISION_GRAMMAR } from '../decisionCommands.ts';
import { asInstant, decidedWhen, filterDecisions, heldWorkRows, historyOf, matchesDecision, sortDecisions, standingLine } from '../decisionFormat.ts';
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

test('a DATE column becomes an instant (the start of that day, here); search reads topic, summary and initiative', () => {
  assert.equal(asInstant('2026-03-12'), new Date(2026, 2, 12).toISOString());
  assert.equal(asInstant('2026-03-12T01:00:00Z'), '2026-03-12T01:00:00Z');
  assert.equal(matchesDecision({ id: 'd-1', topic: 'Cutover', summary: null }, 'auth', 'Auth Migration'), true);
  assert.equal(matchesDecision({ id: 'd-1', topic: 'Cutover', summary: null }, 'zzz'), false);
});

test('the standing line names the decider, never an id', () => {
  const rel = (iso: string) => `rel(${iso})`;
  assert.equal(standingLine({ ...detail('escalated'), escalatedAt: 'T', requiredRole: 'org-leader' }, 'Sienna Garcia', rel), 'Waiting on Sienna Garcia, escalated rel(T)');
  assert.equal(standingLine({ ...detail('escalated'), requiredRole: 'org-leader' }, null, rel), 'Waiting on the org-leader');
  // Settled: when, not who — the record's Decided line is the one place it says "by".
  assert.equal(standingLine(detail('resolved', '2026-03-12'), 'Sienna Garcia', rel), `Decided rel(${asInstant('2026-03-12')})`);
});

test('a decided date is never "in …" (walk, 9 November: "Decided in 8h")', () => {
  const rel = (iso: string) => `rel(${iso})`;
  const afternoon = new Date(2026, 10, 9, 15).getTime();
  // An instant in the past reads relative.
  assert.equal(decidedWhen('2026-11-09T01:40:00Z', rel, Date.parse('2026-11-09T15:00:00Z')), 'rel(2026-11-09T01:40:00Z)');
  // A bare date that is today has no hour to count from.
  assert.equal(decidedWhen('2026-11-09', rel, afternoon), 'today');
  assert.equal(decidedWhen('2026-11-09', rel, new Date(2026, 10, 9, 8).getTime()), 'today', 'the morning the walk saw "in 8h"');
  // An earlier day reads relative from its start.
  assert.equal(decidedWhen('2026-11-03', rel, afternoon), `rel(${asInstant('2026-11-03')})`);
  // Anything ahead of the clock is the date: a bare date ahead of this zone, an instant from a fast clock.
  assert.equal(decidedWhen('2026-11-10', rel, afternoon), 'Nov 10, 2026');
  assert.equal(decidedWhen('2026-11-12T12:00:00Z', rel, afternoon), 'Nov 12, 2026');
  assert.equal(decidedWhen('2026-11-09T01:40:00Z', () => 'in 3h', Date.parse('2026-11-09T15:00:00Z')), new Date('2026-11-09T01:40:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  assert.equal(decidedWhen('not a date', rel, afternoon), 'not a date');
});

test('history: raised last, escalation and the settling call before it', () => {
  const ev = historyOf(detail('resolved', '2026-03-12'), { id: 'd-1', requiredRole: 'org-leader', escalatedAt: 'E', workItemId: null, workItemTitle: null }, 'Auth Migration');
  assert.deepEqual(ev.map((e) => e.id), ['settled', 'escalated', 'raised']);
  assert.equal(ev[0]!.detail, 'The call was made.', 'who is the Decided line\'s to say');
  assert.equal(historyOf(detail('open'), null, null).at(-1)!.detail, 'Raised as an organisation-wide call.');
});

test('held-up work: "Holding up" while it waits, "Unblocked" once resolved, "Still blocked" when rejected', () => {
  const runbook = { id: 'wi-2', title: 'Cutover runbook', projectId: 'p-1', blocked: true };
  const href = '/iq/projects/p-1?tab=work&item=wi-2';
  assert.deepEqual(heldWorkRows({ ...detail('escalated'), heldWork: [runbook] }, null), [{ id: 'wi-2', title: 'Cutover runbook', href, label: 'Holding up' }]);
  assert.equal(heldWorkRows({ ...detail('resolved'), heldWork: [{ ...runbook, blocked: false }] }, null)[0]!.label, 'Unblocked');
  assert.equal(heldWorkRows({ ...detail('rejected'), heldWork: [runbook] }, null)[0]!.label, 'Still blocked');
  // An older server sends no heldWork: the initiative row's linked item, labelled for what is known.
  const row = { id: 'd-1', requiredRole: null, escalatedAt: null, workItemId: 'wi-2', workItemTitle: 'Cutover runbook' };
  assert.equal(heldWorkRows(detail('open'), row)[0]!.label, 'Holding up');
  assert.equal(heldWorkRows(detail('resolved'), row)[0]!.label, 'Linked work');
  // The history says it was unblocked when the call was made.
  const ev = historyOf({ ...detail('resolved', '2026-11-10'), heldWork: [{ ...runbook, blocked: false }],
    history: [{ id: '1', kind: 'resolved', at: '2026-11-10T09:00:00Z', by: { id: 'p-2', name: 'Vera Green' }, rationale: 'Riskiest two tenants first' }] }, null, null);
  assert.deepEqual(ev.slice(0, 2).map((e) => [e.label, e.detail, e.at]), [['Unblocked', 'Cutover runbook', '2026-11-10T09:00:00Z'], ['Decided', 'Riskiest two tenants first', '2026-11-10T09:00:00Z']]);
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
