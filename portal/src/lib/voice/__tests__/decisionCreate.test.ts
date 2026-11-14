// Meeting consent, package 4: create { kind: 'decision' } records a statement
// agreed on an initiative. It is a write behind a click-only card; waiting, it is
// raised for the initiative's owner; resolved, it is recorded with the user as
// decider (the route allows that only to someone who may decide there). The
// result links the new record without navigating, since the card may be
// answered in the middle of a call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planPreparedCall, prepareToolCall, runPreparedCall, type ConfirmPlan, type ToolResult } from '../tools.ts';
import type { PublishedPage } from '../pageContext.ts';
import { fakeFetch, route, toolContext, type LoggedRequest, type Route } from './voiceHarness.ts';
import type { Action } from '../../capabilities';

const PAGE: PublishedPage = { path: '/iq/projects/p-auth', record: { ref: 'initiative:p-auth', title: 'Auth Migration' }, rowsLabel: 'work items', rows: [] };
const STATEMENT = 'Cut over the smallest tenants first';
const writes = (log: readonly LoggedRequest[]) => log.filter((l) => l.method !== 'GET').map((l) => [l.method, l.url, l.body]);
const PROJECT = (canWriteWork: boolean): Route => route('GET', '/api/graph/projects/p-auth', 200, { id: 'p-auth', name: 'Auth Migration', canWriteWork });
const CREATED: Route = (req) => (req.method === 'POST' && req.url === '/api/graph/decisions'
  ? { status: 201, body: { id: 'd-new', topic: STATEMENT, status: (req.body as { state: string }).state === 'resolved' ? 'resolved' : 'open' } } : undefined);

async function plan(fields: Record<string, unknown>, opts: { allow?: Action[]; routes?: Route[] } = {}) {
  const { fetch, log } = fakeFetch(opts.routes ?? [PROJECT(true), CREATED]);
  const ctx = toolContext({ fetch, tenant: 'orgiq', allow: opts.allow ?? ['RaiseDecision'], page: () => PAGE });
  const p = prepareToolCall('create', { kind: 'decision', fields }, ctx);
  assert.ok(p.ok, `create decision ${JSON.stringify(fields)} validates`);
  const { VOICE_PLANNERS, VOICE_RUNNERS } = await import('../actions.ts');
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (!planned || 'result' in planned) return { card: null as ConfirmPlan | null, result: planned?.result as ToolResult, log, ctx, run: null as ToolResult | null, call: p.call };
  assert.deepEqual(writes(log), [], 'nothing is written before the confirm');
  const run = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  return { card: planned.plan, result: run, log, ctx, run, call: p.call };
}

test('a decision agreed in a call is raised for the owner: one card, the route with the call and who agreed, and a link to the record without navigating', async () => {
  const r = await plan({ initiative: 'this-page', statement: STATEMENT, state: 'waiting', participants: ['u-sam', 'u-priya'], call: 'call-7' });
  assert.equal(r.card!.title, 'Raise a decision on Auth Migration');
  assert.deepEqual(r.card!.detail, [`"${STATEMENT}"`, 'It waits on the owner of Auth Migration to decide.', 'Agreed by 2 people in the call.']);
  assert.deepEqual(writes(r.log), [['POST', '/api/graph/decisions', { initiativeId: 'p-auth', statement: STATEMENT, state: 'waiting', source: 'call', callId: 'call-7', participants: ['u-sam', 'u-priya'] }]]);
  assert.equal(r.run!.outcome, 'done');
  assert.equal(r.run!.output['id'], 'd-new');
  assert.equal(r.run!.output['href'], '/iq/decisions/d-new');
  assert.deepEqual(r.ctx.navigations, [], 'a card answered in a call never moves the page');
});

test('the card is click-only: a decision is never confirmed aloud', async () => {
  const r = await plan({ initiative: 'this-page', statement: STATEMENT, state: 'waiting' });
  assert.deepEqual(r.call.spec.clickFor, { kind: ['access-request', 'decision'] });
});

test('recorded as decided needs the decide capability; by hand it is a manual decision', async () => {
  const refused = await plan({ initiative: 'this-page', statement: STATEMENT, state: 'resolved' });
  assert.equal(refused.card, null);
  assert.match(String(refused.result.output['error'] ?? refused.result.summary ?? ''), /raise it for the owner/);
  const r = await plan({ initiative: 'this-page', statement: STATEMENT, state: 'resolved' }, { allow: ['RaiseDecision', 'DecideDecision'] });
  assert.equal(r.card!.title, 'Record the decision on Auth Migration');
  assert.deepEqual(writes(r.log), [['POST', '/api/graph/decisions', { initiativeId: 'p-auth', statement: STATEMENT, state: 'resolved', source: 'manual' }]]);
});

test('someone not on the initiative is refused before a card; a role without RaiseDecision is refused', async () => {
  const off = await plan({ initiative: 'this-page', statement: STATEMENT, state: 'waiting' }, { routes: [PROJECT(false), CREATED] });
  assert.equal(off.card, null);
  assert.equal(off.result.output['code'], 'not-on-initiative');
  const role = await plan({ initiative: 'this-page', statement: STATEMENT, state: 'waiting' }, { allow: [] });
  assert.equal(role.card, null);
  assert.deepEqual(writes(role.log), []);
});
