// Rediscovery — /api/rediscovery (routes/rediscovery.ts). "Look before you
// spend": the pre-flight that finds an existing solution before an agent run
// is authorised, and the outcome the human reports back.
//
// What is pinned:
//   * the auth floor the router's header argues for — NO capability gate on
//     any of the three routes (the mount's session floor is the whole of it).
//     A capability check here would defeat the feature at the moment it
//     matters, so a gate appearing on this router is the regression,
//   * the check envelope (`matches` + the two avoided estimates) and that
//     optional context coerces to NULL rather than to a default that would
//     make a savings claim up,
//   * that `dismissed` is a first-class outcome — the retrieval-drift signal
//     the stats route reports beside the flattering half,
//   * the validation branches: no problem, no experienceId, an action that
//     is neither used nor dismissed.

jest.mock('../../providers/rediscovery.js', () => ({
  checkRediscovery: jest.fn(),
  recordOutcome: jest.fn(),
  rediscoveryStats: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import * as rediscoveryRouteModule from '../rediscovery.js';
import { rediscoveryRouter } from '../rediscovery.js';
import { errorHandler } from '../../lib/async-handler.js';
import { checkRediscovery, recordOutcome, rediscoveryStats } from '../../providers/rediscovery.js';

const checkMock = checkRediscovery as unknown as jest.Mock;
const outcomeMock = recordOutcome as unknown as jest.Mock;
const statsMock = rediscoveryStats as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rediscovery', rediscoveryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  checkMock.mockReset(); outcomeMock.mockReset(); statsMock.mockReset();
  outcomeMock.mockResolvedValue(undefined);
});

describe('auth floor', () => {
  it('imports no capability gate at all — the mount\'s session floor is the whole of it', () => {
    // routes/rediscovery.ts deliberately does not import lib/authz. A gate
    // appearing here would hide the "somebody already solved this" answer
    // from exactly the person about to pay to solve it again.
    expect(Object.keys(rediscoveryRouteModule)).toEqual(['rediscoveryRouter']);
  });
});

describe('POST /api/rediscovery/check', () => {
  it('400s a missing or blank problem before any retrieval', async () => {
    for (const body of [{}, { problem: '' }, { problem: '   ' }, { problem: 7 }]) {
      const res = await request(buildApp()).post('/api/rediscovery/check').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/problem/);
    }
    expect(checkMock).not.toHaveBeenCalled();
  });

  it('returns matches beside both avoided estimates', async () => {
    checkMock.mockResolvedValue({
      matches: [{ id: 'exp-1', title: 'Data API cold start', score: 0.8, repo: 'orgiq' }],
      estimateAvoidedUsd: 4.25, estimateAvoidedMinutes: 90,
    });
    const res = await request(buildApp())
      .post('/api/rediscovery/check').send({ problem: '  cold start  ' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort())
      .toEqual(['estimateAvoidedMinutes', 'estimateAvoidedUsd', 'matches']);
    expect(checkMock.mock.calls[0]![0]).toMatchObject({ problem: 'cold start' });
  });

  it('coerces every optional field to null — an absent estimate is not zero', async () => {
    checkMock.mockResolvedValue({ matches: [], estimateAvoidedUsd: null, estimateAvoidedMinutes: null });
    await request(buildApp()).post('/api/rediscovery/check').send({ problem: 'x' });
    expect(checkMock).toHaveBeenCalledWith({
      problem: 'x', repo: null, initiativeId: null, workItemId: null,
      estimateUsd: null, estimateMinutes: null,
    });
  });

  it('drops a wrongly-typed estimate to null rather than passing a string through', async () => {
    checkMock.mockResolvedValue({ matches: [], estimateAvoidedUsd: null, estimateAvoidedMinutes: null });
    await request(buildApp()).post('/api/rediscovery/check')
      .send({ problem: 'x', estimateUsd: '12', repo: 'orgiq', initiativeId: 'p-obs' });
    expect(checkMock).toHaveBeenCalledWith({
      problem: 'x', repo: 'orgiq', initiativeId: 'p-obs', workItemId: null,
      estimateUsd: null, estimateMinutes: null,
    });
  });

  it('reports "nothing found" as an empty match list, not a 404', async () => {
    checkMock.mockResolvedValue({ matches: [], estimateAvoidedUsd: null, estimateAvoidedMinutes: null });
    const res = await request(buildApp()).post('/api/rediscovery/check').send({ problem: 'novel' });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });
});

describe('POST /api/rediscovery/outcome', () => {
  it('requires an experienceId and one of exactly two actions', async () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { experienceId: 'exp-1' },
      { experienceId: 'exp-1', action: 'ignored' },
      { action: 'used' },
    ];
    for (const body of cases) {
      const res = await request(buildApp()).post('/api/rediscovery/outcome').send(body);
      expect(res.status).toBe(400);
    }
    expect(outcomeMock).not.toHaveBeenCalled();
  });

  it('records a USED outcome with its savings', async () => {
    const res = await request(buildApp()).post('/api/rediscovery/outcome').send({
      experienceId: 'exp-1', action: 'used', workItemId: 'wi-3',
      avoidedUsd: 4.25, avoidedMinutes: 90,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(outcomeMock).toHaveBeenCalledWith({
      experienceId: 'exp-1', workItemId: 'wi-3', action: 'used',
      reason: null, avoidedUsd: 4.25, avoidedMinutes: 90,
    });
  });

  it('records a DISMISSED outcome with its reason — the retrieval-drift signal', async () => {
    const res = await request(buildApp()).post('/api/rediscovery/outcome')
      .send({ experienceId: 'exp-1', action: 'dismissed', reason: 'different stack' });
    expect(res.status).toBe(200);
    expect(outcomeMock).toHaveBeenCalledWith({
      experienceId: 'exp-1', workItemId: null, action: 'dismissed',
      reason: 'different stack', avoidedUsd: null, avoidedMinutes: null,
    });
  });
});

describe('GET /api/rediscovery/stats', () => {
  it('reports dismissals BESIDE the savings, and echoes the window', async () => {
    statsMock.mockResolvedValue({
      shortCircuits: 4, dismissals: 2, usdAvoided: 17.5, minutesAvoided: 320, windowDays: 30,
    });
    const res = await request(buildApp()).get('/api/rediscovery/stats');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort())
      .toEqual(['dismissals', 'minutesAvoided', 'shortCircuits', 'usdAvoided', 'windowDays']);
    expect(res.body.dismissals).toBe(2);
    expect(statsMock).toHaveBeenCalledWith(30);
  });

  it('defaults a non-numeric window to 30 and forwards a numeric one', async () => {
    statsMock.mockResolvedValue({ shortCircuits: 0, dismissals: 0, usdAvoided: 0, minutesAvoided: 0, windowDays: 7 });
    const app = buildApp();
    await request(app).get('/api/rediscovery/stats?windowDays=abc');
    await request(app).get('/api/rediscovery/stats?windowDays=7');
    expect(statsMock.mock.calls.map((c) => c[0])).toEqual([30, 7]);
  });
});
