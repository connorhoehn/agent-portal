// GET /api/today — the footer's Today strip reads the same rows as the pages
// behind it (docs/demo-content-audit.md X4): no fixed "Demo" figure survives.
jest.mock('../../config.js', () => ({
  config: {
    auth: { policyStoreId: undefined, cognito: null },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    region: 'us-east-1',
  },
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { todayRouter, type TodayItem } from '../today.js';
import { orgSummary } from '../../providers/budgets.js';
import { listConsults } from '../../providers/lab.js';
import { labConsults } from '../../mock/lab.js';
import { errorHandler } from '../../lib/async-handler.js';

function appAs(session: { sub: string; role: string; tenant: string } | null) {
  const app = express();
  app.use((req, _res, next) => {
    if (session) (req as unknown as { session: unknown }).session = { ...session, iat: 0, grants: { [session.tenant]: [session.role] } };
    next();
  });
  app.use('/api/today', todayRouter);
  app.use(errorHandler);
  return app;
}
const items = async (session: { sub: string; role: string; tenant: string }) =>
  ((await request(appAs(session)).get('/api/today')).body as { items: TodayItem[] }).items;

afterEach(() => labConsults.reset());

it('the budget item is the Budgets page summary, for the roles that may read it', async () => {
  const mia = await items({ sub: 'u-mia', role: 'program-owner', tenant: 'orgiq' });
  const budget = mia.find((i) => i.category === 'budget')!;
  const s = await orgSummary();
  expect(budget.summary).toContain(`$${s.totalSpentThisPeriodUsd.toFixed(2)} of $${s.totalAllocatedUsd.toFixed(2)} spent this month`);
  // A member is not shown figures the Budgets read gate hides from them.
  const theo = await items({ sub: 'u-theo', role: 'member', tenant: 'orgiq' });
  expect(theo.some((i) => i.category === 'budget')).toBe(false);
});

it('the review item counts the pending consults and names the question', async () => {
  const pending = await listConsults({ status: 'pending' });
  const review = (await items({ sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' })).find((i) => i.category === 'review')!;
  if (pending.length === 0) expect(review.summary).toBe('Nothing is waiting on a person');
  else expect(review.summary).toBe(`${pending.length} agent question${pending.length === 1 ? '' : 's'} waiting for an answer`);
  labConsults.rows().splice(0);
  const none = (await items({ sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' })).find((i) => i.category === 'review')!;
  expect(none.summary).toBe('Nothing is waiting on a person');
});

it('another tenant gets no items, so the strip stays hidden rather than inventing one', async () => {
  expect(await items({ sub: 'u-sana', role: 'participant', tenant: 'social' })).toEqual([]);
});
