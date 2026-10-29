// GET /api/me/spend (DE-31): one person's spend per initiative from the
// ledger, offline — the seeded fleet's finished tasks plus whatever this
// test writes. The sender is charged, never the box owner, and the query
// cannot widen the read to someone else.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireSession } from '../../lib/authz.js';
import { meSpendRouter } from '../me-spend.js';
import { recordSpend } from '../../providers/spend-ledger.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { freezeClock } from '../../mock/core/index.js';
import { __resetMockRuns } from '../../providers/bots.js';
import type { Session } from '../../lib/session.js';

const app = express();
app.use((req, _res, next) => {
  const sub = req.headers['x-user'];
  if (typeof sub === 'string') req.session = { sub, tenant: 'orgiq', role: 'sme', iat: 1, grants: { orgiq: ['sme'] } } as unknown as Session;
  next();
});
app.use('/api/me/spend', requireSession('MySpend'), meSpendRouter);
app.use(errorHandler);

let unfreeze: () => void;
beforeAll(() => { unfreeze = freezeClock('2026-10-29T12:00:00.000Z'); });
afterAll(() => unfreeze());
beforeEach(() => {
  spendEntries.reset();
  spendEntries.rows().length = 0;
  __resetMockRuns();
});

describe('GET /api/me/spend', () => {
  it('sums the caller\'s own entries per initiative, with unknowns counted apart and unattributed spend under null', async () => {
    const base = { boxId: 'box-shared', model: 'sonnet' } as const;
    await recordSpend({ ...base, source: 'box_task', sourceId: 'box-shared:1', initiativeId: 'p-x', actorId: 'u-sme', costUsd: 0.5 });
    await recordSpend({ ...base, source: 'box_task', sourceId: 'box-shared:2', initiativeId: 'p-x', actorId: 'u-sme', costUsd: null });
    await recordSpend({ ...base, source: 'box_task', sourceId: 'box-shared:3', initiativeId: null, actorId: 'u-sme', costUsd: 0.25 });
    // The box owner's own task is theirs, not the caller's.
    await recordSpend({ ...base, source: 'box_task', sourceId: 'box-shared:4', initiativeId: 'p-x', actorId: 'u-owner', costUsd: 9 });

    const res = await request(app).get('/api/me/spend').query({ actorId: 'u-owner' }).set('x-user', 'u-sme');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actorId: 'u-sme', period: 'month', since: '2026-10-01T00:00:00.000Z', knownUsd: 0.75, unknownCount: 1 });
    expect(res.body.byInitiative).toEqual([
      { initiativeId: 'p-x', knownUsd: 0.5, unknownCount: 1, entries: 2, bySource: { box_task: 0.5 } },
      { initiativeId: null, knownUsd: 0.25, unknownCount: 0, entries: 1, bySource: { box_task: 0.25 } },
    ]);
  });

  it('refuses an unknown period', async () => {
    expect((await request(app).get('/api/me/spend').query({ period: 'year' }).set('x-user', 'u-sme')).status).toBe(400);
  });
});
