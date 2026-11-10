// Coverage (10 November), capability 7: knowledge. "Find the runbook for cutover" (search knowledge; a runbook hit is a
// runbook ref), "open the ADR about the dependency map" (the decision's record document, first in the rows), and a
// runbook's steps read count first, one at a time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultMemory, runVoiceTool, type ToolContext } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';

const RUNBOOK_HIT = { type: 'knowledge', id: 'rb-tenant-cutover', title: 'Cut one tenant over from SAML to Cognito', subtitle: 'Runbook · v1', href: '/iq/runbooks/rb-tenant-cutover', matchReason: 'Text match' };
const STEPS = [
  { do: 'Confirm sign-in works on the shim before you touch anything.', command: { lang: 'bash', text: 'curl -s "$ORIGIN/api/auth/config"' }, expect: '`false`.' },
  { do: 'Flip only this tenant\'s flag, never several tenants in one change.', expect: 'a new parameter Version.' },
  { do: 'Sign in as a test user of this tenant.' },
];

function ctxFor(over: Partial<ToolContext> & { extra?: Route[] } = {}) {
  const { extra, ...rest } = over;
  const { fetch, log } = fakeFetch([
    ...(extra ?? []),
    route('GET', '/api/search?q=dependency+map&type=decision', 200, { results: [{ type: 'decision', id: 'd-aurora', title: 'Service dependency map in Postgres, not a graph database' }], total: 1 }),
    route('GET', '/api/search', 200, { results: [RUNBOOK_HIT], total: 1 }),
    route('GET', '/api/graph/documents/adr-d-aurora', 200, { id: 'adr-d-aurora', source: 'adr', title: 'ADR: Service dependency map in Postgres, not a graph database', href: '/iq/documents/adr-d-aurora' }),
    route('GET', '/api/runbooks/rb-tenant-cutover', 200, { runbook: { id: 'rb-tenant-cutover', title: 'Cut one tenant over from SAML to Cognito', health: { warning: 'Last run failed at step 2.' } }, current: { version: 1, doc: { title: 'Cut one tenant over from SAML to Cognito', steps: STEPS } } }),
  ]);
  const ctx = toolContext({ fetch, results: new ResultMemory(), ...rest });
  return { ctx, log };
}

test('search knowledge: a runbook hit is a runbook ref, so its steps are read by ref; open goes to its page', async () => {
  const { ctx } = ctxFor();
  const r = await runVoiceTool('search', { query: 'tenant cutover', type: 'knowledge' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.equal((r.output['rows'] as Array<Record<string, unknown>>)[0]!['ref'], 'runbook:rb-tenant-cutover');
  const open = await runVoiceTool('open', { ref: 'runbook:rb-tenant-cutover' }, ctx);
  assert.equal(open.outcome, 'done');
  assert.deepEqual(ctx.navigations.at(-1), '/iq/runbooks/rb-tenant-cutover');
});

test('search knowledge "the ADR about the dependency map": the decision\'s record document first, opened by its ref', async () => {
  const { ctx, log } = ctxFor();
  const r = await runVoiceTool('search', { query: 'the ADR about the dependency map', type: 'knowledge' }, ctx);
  assert.ok(log.some((l) => l.url === '/api/graph/documents/adr-d-aurora'));
  const first = (r.output['rows'] as Array<Record<string, unknown>>)[0]!;
  assert.equal(first['ref'], 'document:adr-d-aurora');
  assert.equal(first['title'], 'ADR: Service dependency map in Postgres, not a graph database');
  const open = await runVoiceTool('open', { ref: 'document:adr-d-aurora' }, ctx);
  assert.equal(open.outcome, 'done');
  assert.equal(ctx.navigations.at(-1), '/iq/documents/adr-d-aurora');
  // Without "ADR" in the words nothing extra is read.
  const before = log.length;
  await runVoiceTool('search', { query: 'dependency map', type: 'knowledge' }, ctx);
  assert.ok(!log.slice(before).some((l) => l.url.startsWith('/api/graph/documents/')));
});

test('get runbook part steps: the count and step one in the line; every step numbered in the rows; the health warning kept', async () => {
  const { ctx } = ctxFor();
  const r = await runVoiceTool('get', { ref: 'runbook:rb-tenant-cutover', part: 'steps' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.equal(r.output['say'], '3 steps in "Cut one tenant over from SAML to Cognito"; 1: Confirm sign-in works on the shim before you touch anything.');
  const rows = r.output['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows[1]!['title'], '2. Flip only this tenant\'s flag, never several tenants in one change.');
  assert.equal(r.output['warning'], 'Last run failed at step 2.');
  assert.doesNotMatch(JSON.stringify(r.output), /curl/, 'commands stay on the page');
});
