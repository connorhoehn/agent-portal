// Coverage (10 November), capability 4: sprint questions. "What's left in this sprint", "what is blocked and on what"
// as one summary of the sprint in view (or the user's one active sprint), through the sprint board's read; "what got
// done last sprint" is list work-item { sprint: 'last', status: 'done' } (coverageWork.test.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultMemory, runVoiceTool, type ToolContext } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';
import { AUTH_DECISIONS, AUTH_PAGE, AUTH_SPRINTS, AUTH_TREE, P } from './coverageFixtures.ts';

const BOARD = AUTH_TREE[0]!.children.filter((c) => (c as { sprintId?: string }).sprintId === 'spr-auth-s2');
const MINE = (n: number) => ({ scope: 'mine', sprints: [
  { id: 'spr-auth-s2', orgProjectId: P, orgProjectName: 'Auth Migration', name: 'Sprint 10 — Session hygiene', status: 'active', endsOn: '2026-11-15', myItemCount: 1 },
  { id: 'spr-obs-s3', orgProjectId: 'p-observability', orgProjectName: 'Observability Platform', name: 'Sprint 11 — Span metrics', status: 'active', endsOn: '2026-11-15', myItemCount: n },
  { id: 'spr-auth-s1', orgProjectId: P, orgProjectName: 'Auth Migration', name: 'Sprint 9 — OIDC core', status: 'done', myItemCount: 2 },
] });

function ctxFor(over: Partial<ToolContext> & { extra?: Route[] } = {}) {
  const { extra, ...rest } = over;
  const { fetch, log } = fakeFetch([
    ...(extra ?? []),
    route('GET', '/api/sprints?initiative=', 200, AUTH_SPRINTS),
    route('GET', '/api/sprints', 200, MINE(0)),
    route('GET', '/api/graph/work?sprint=spr-auth-s2', 200, BOARD),
    route('GET', `/api/graph/projects/${P}/decisions`, 200, AUTH_DECISIONS),
  ]);
  const ctx = toolContext({ fetch, results: new ResultMemory(), page: () => AUTH_PAGE, ...rest });
  return { ctx, log };
}

test('summary sprint on an initiative: its active sprint\'s board; left, done, and the blocked row named with its decision', async () => {
  const { ctx, log } = ctxFor();
  const r = await runVoiceTool('summary', { kind: 'sprint' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.ok(log.some((l) => l.url === '/api/graph/work?sprint=spr-auth-s2&limit=200'), log.map((l) => l.url).join(' '));
  assert.equal(r.output['left'], 2);
  assert.equal(r.output['blocked'], 1);
  const rows = r.output['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows[0]!['title'], 'Tenant-by-tenant cutover runbook with rollback', 'the blocked row comes first');
  assert.match(String(rows[0]!['subtitle']), /blocked on "Cutover order for legacy SSO tenants"/);
  assert.equal(r.output['say'], 'Sprint 10 — Session hygiene: 2 left, none done; 1 blocked, on "Cutover order for legacy SSO tenants".');
  // The rows are kept: "the first one" reads the blocked item.
  assert.equal(ctx.results!.find('1')!.ref, 'work-item:wi-auth-e2-s2');
});

test('summary sprint off an initiative: the one active sprint the user has work in; several are asked about, none refused', async () => {
  const { ctx } = ctxFor({ page: () => null });
  const r = await runVoiceTool('summary', { kind: 'sprint' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.equal(r.output['initiative'], 'Auth Migration');
  const { ctx: two } = ctxFor({ page: () => null, extra: [route('GET', '/api/sprints', 200, MINE(1))] });
  const both = await runVoiceTool('summary', { kind: 'sprint' }, two);
  assert.equal(both.outcome, 'refused');
  assert.equal(both.output['kind'], 'ambiguous');
  const { ctx: none } = ctxFor({ page: () => null, extra: [route('GET', '/api/sprints', 200, { sprints: [] })] });
  const nothing = await runVoiceTool('summary', { kind: 'sprint' }, none);
  assert.equal(nothing.output['code'], 'not-found');
});

test('list work-item status blocked: the count, then the first row and the decision it waits on', async () => {
  const { ctx } = ctxFor({ extra: [route('GET', `/api/graph/projects/${P}/work`, 200, AUTH_TREE)] });
  const r = await runVoiceTool('list', { kind: 'work-item', filter: { status: 'blocked' } }, ctx);
  assert.equal(r.outcome, 'done');
  assert.equal(r.output['say'], '1 blocked work item on Auth Migration: "Tenant-by-tenant cutover runbook with rollback" on "Cutover order for legacy SSO tenants".');
});
