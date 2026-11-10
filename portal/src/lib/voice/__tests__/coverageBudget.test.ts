// Coverage (10 November), capability 2: budgets and spend. "How much is left on this initiative / this sprint /
// my envelope" and "what did the agents spend this week on Auth Migration", through the reads the Budget tab and
// the envelopes panel make, at the budgets read tier; below it, the refusal with the access request and no figure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultMemory, runVoiceTool, type ToolContext } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';
import { AUTH_PAGE, AUTH_SPRINTS, P } from './coverageFixtures.ts';
import type { Action } from '../../capabilities';

const ENVELOPES = [
  { grantId: 'bg-auth-2', granteeName: 'Simone Chang', sprintId: 'spr-auth-s2', sprintName: 'Sprint 10 — Session hygiene', sprintStatus: 'active', allocatedUsd: 20, spentUsd: 0, remainingUsd: 20 },
  { grantId: 'bg-auth-3', granteeName: 'Nora DaSilva', sprintId: 'spr-auth-s2', sprintName: 'Sprint 10 — Session hygiene', sprintStatus: 'active', allocatedUsd: 15, spentUsd: 0, remainingUsd: 15 },
  { grantId: 'bg-auth-1', granteeName: 'Simone Chang', sprintId: 'spr-auth-s1', sprintName: 'Sprint 9 — OIDC core', sprintStatus: 'done', allocatedUsd: 25, spentUsd: 0, remainingUsd: 25 },
];
/** The initiative's report at the tier (routes/spend-report.ts). */
const REPORT = {
  period: '7d', initiativeId: P, totals: { knownUsd: 9.72, heldUsd: 0, burnPerDay7d: 1.3886, projectedPeriodEndUsd: 40.77 },
  groups: [{ key: 'u-vera', label: 'Vera Green', knownUsd: 7.11 }, { key: 'u-nora', label: 'Nora DaSilva', knownUsd: 2.41 }],
  initiative: {
    id: P, name: 'Auth Migration',
    allocation: { allocatedUsd: 75, effectiveAllocatedUsd: 75, spentUsd: 7.76 }, reserve: { discretionaryRemainingUsd: 67.108 }, envelopes: ENVELOPES,
  },
};
const LOCK = { visible: false, reason: 'Spend and allocation are visible to the budgets read tier.', requestItemId: 'capability:orgiq:budgets-read' };
/** The same report below the tier: the dollar fields withheld, only the caller's own envelope. */
const BELOW = {
  period: 'month', initiativeId: P, totals: { unknownCount: 0, entries: 7 }, groups: [{ key: 'u-nora', label: 'Nora DaSilva', knownUsd: 2.41 }],
  initiative: { id: P, name: 'Auth Migration', envelopes: [ENVELOPES[1]], budgetAccess: LOCK }, budgetAccess: LOCK,
};

function ctxFor(over: Partial<ToolContext> & { allow?: Action[]; deny?: Action[]; report?: unknown; extra?: Route[] } = {}) {
  const { report, extra, ...rest } = over;
  const { fetch, log } = fakeFetch([
    ...(extra ?? []),
    route('GET', '/api/spend/report', 200, report ?? REPORT),
    route('GET', '/api/sprints/envelopes', 200, { envelopes: [{ orgProjectName: 'Auth Migration', sprintName: 'Sprint 10 — Session hygiene', allocatedUsd: 15, spentUsd: 0, remainingUsd: 15 }] }),
    route('GET', '/api/sprints', 200, AUTH_SPRINTS),
    route('GET', '/api/graph/projects', 200, [{ id: P, name: 'Auth Migration' }, { id: 'p-other', name: 'Search Relevance' }]),
  ]);
  const ctx = toolContext({ fetch, results: new ResultMemory(), page: () => AUTH_PAGE, role: 'org-leader', ...rest });
  return { ctx, log };
}

const urls = (log: Array<{ url: string }>) => log.map((l) => l.url);
const words = (s: unknown) => String(s).trim().split(/\s+/).length;

test('budget initiative "this-page": the Budget tab\'s report for the initiative in view; spend, allocation and what is left', async () => {
  const { ctx, log } = ctxFor();
  const r = await runVoiceTool('budget', { scope: 'initiative', initiative: 'this-page' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.ok(urls(log).includes(`/api/spend/report?groupBy=actor&initiativeId=${P}`), urls(log).join(' '));
  assert.equal(r.output['allocatedUsd'], 75);
  assert.equal(r.output['discretionaryLeftUsd'], 67.108);
  assert.equal(r.output['say'], 'Auth Migration spent $7.76 of its $75.00 allocation this month; $67.11 discretionary left.');
  assert.ok(words(r.output['say']) <= 25);
  // No name on the initiative's page reads the one in view, without a lookup.
  const bare = await runVoiceTool('budget', { scope: 'initiative' }, ctx);
  assert.equal(bare.outcome, 'done');
  assert.ok(!urls(log).some((u) => u.startsWith('/api/graph/projects')), 'the page names the initiative; nothing is looked up');
});

test('budget initiative, period 7d: "what did the agents spend this week on Auth Migration" by name, the week\'s report', async () => {
  const { ctx, log } = ctxFor({ page: () => null });
  const r = await runVoiceTool('budget', { scope: 'initiative', initiative: 'Auth Migration', period: '7d' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.ok(urls(log).includes(`/api/spend/report?groupBy=actor&initiativeId=${P}&period=7d`), urls(log).join(' '));
  assert.match(String(r.output['say']), /^Auth Migration spent \$9\.72 in the last 7 days; \$67\.11 discretionary left/);
  // "this-page" off any initiative is said as such.
  const off = await runVoiceTool('budget', { scope: 'initiative', initiative: 'this-page' }, ctx);
  assert.equal(off.outcome, 'refused');
  assert.equal(off.output['code'], 'not-on-this-page');
});

test('budget envelopes on this page and this sprint: the initiative\'s envelopes, summed; the user\'s own envelope without one', async () => {
  const { ctx, log } = ctxFor();
  const r = await runVoiceTool('budget', { scope: 'envelopes', initiative: 'this-page', sprint: 'this' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.equal(r.output['count'], 2);
  assert.equal(r.output['remainingUsd'], 35);
  assert.equal(r.output['say'], '2 envelopes on Auth Migration, Sprint 10 — Session hygiene: $35.00 left of $35.00.');
  const last = await runVoiceTool('budget', { scope: 'envelopes', initiative: 'this-page', sprint: 'last' }, ctx);
  assert.equal(last.output['say'], '1 envelope on Auth Migration, Sprint 9 — OIDC core: $25.00 left of $25.00.');
  // Off an initiative page, "my envelope" is the envelopes route.
  const { ctx: off, log: offLog } = ctxFor({ page: () => null });
  const mine = await runVoiceTool('budget', { scope: 'envelopes' }, off);
  assert.ok(urls(offLog).includes('/api/sprints/envelopes'));
  assert.equal(mine.output['say'], '1 envelope: Auth Migration, Sprint 10 — Session hygiene, $15.00 left of $15.00.');
  assert.ok(urls(log).every((u) => !u.includes('/api/sprints/envelopes')));
});

test('budget below the tier: the initiative is refused with code role, the access request and no figure; the own envelope is still said', async () => {
  const { ctx } = ctxFor({ role: 'sme', deny: ['ManageBudgets'], report: BELOW });
  const r = await runVoiceTool('budget', { scope: 'initiative', initiative: 'this-page' }, ctx);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.output['code'], 'role');
  assert.equal(r.output['requestItemId'], 'capability:orgiq:budgets-read');
  assert.match(String(r.output['next']), /access/i);
  assert.doesNotMatch(JSON.stringify(r.output), /\$|\d+\.\d\d/, 'no figure in a refusal');
  const env = await runVoiceTool('budget', { scope: 'envelopes', initiative: 'this-page', sprint: 'this' }, ctx);
  assert.equal(env.outcome, 'done');
  assert.equal(env.output['say'], '1 envelope of yours on Auth Migration, Sprint 10 — Session hygiene: $15.00 left of $15.00.');
});
