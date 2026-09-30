// Promotions inbox — /api/promotions (routes/promotions.ts).
//
// What is pinned:
//   * the auth floor the router's header claims — reads OPEN (the queue is
//     meant to be visible to the team), both writes on ManageBots,
//   * the `{candidates: [...]}` envelope the inbox reads, and that a status
//     filter is only forwarded when it is non-blank (a blank `?status=` used
//     to mean "no candidates" instead of "no filter"),
//   * that the approver is taken from the SESSION, never from the body — the
//     one thing an audit of this queue rests on,
//   * the three refusal branches: 404 for an unknown id, 409 for a candidate
//     the promotion gate refuses, 400 for a dismissal with no reason.

const gateCalls: string[] = [];
let sessionValue: { sub: string; name?: string } | null = { sub: 'u-1', name: 'Priya Raman' };

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  resolveSession: () => sessionValue,
}));

jest.mock('../../providers/promotions.js', () => ({
  listCandidates: jest.fn(),
  getCandidate: jest.fn(),
  promoteCandidate: jest.fn(),
  dismissCandidate: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { promotionsRouter } from '../promotions.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listCandidates, getCandidate, promoteCandidate, dismissCandidate,
} from '../../providers/promotions.js';

const listMock = listCandidates as unknown as jest.Mock;
const getMock = getCandidate as unknown as jest.Mock;
const promoteMock = promoteCandidate as unknown as jest.Mock;
const dismissMock = dismissCandidate as unknown as jest.Mock;

const CANDIDATE = {
  id: 'pc-1', title: 'Retry the Data API cold start', proposedKind: 'runbook',
  status: 'candidate', supportCount: 4, rationale: 'seen on four boxes',
  dryRunRunId: null, dryRun: null, dryRunPassed: null, observations: [],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/promotions', promotionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  listMock.mockReset(); getMock.mockReset(); promoteMock.mockReset(); dismissMock.mockReset();
  sessionValue = { sub: 'u-1', name: 'Priya Raman' };
});

describe('auth floor', () => {
  it('gates the two writes on ManageBots and leaves the reads open', () => {
    // One gate constructed at module load, shared by promote + dismiss.
    expect(gateCalls).toEqual(['ManageBots']);
  });
});

describe('GET /api/promotions', () => {
  it('wraps the queue in `candidates`', async () => {
    listMock.mockResolvedValue([CANDIDATE]);
    const res = await request(buildApp()).get('/api/promotions');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['candidates']);
    expect(res.body.candidates[0].proposedKind).toBe('runbook');
    expect(res.body.candidates[0].supportCount).toBe(4);
  });

  it('forwards a status filter only when it is non-blank', async () => {
    listMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/promotions');
    await request(app).get('/api/promotions?status=');
    await request(app).get('/api/promotions?status=approved');
    expect(listMock.mock.calls.map((c) => c[0])).toEqual([{}, {}, { status: 'approved' }]);
  });

  it('serves an empty queue as an empty list', async () => {
    listMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/promotions');
    expect(res.body).toEqual({ candidates: [] });
  });
});

describe('GET /api/promotions/:id', () => {
  it('returns the candidate, and 404s an unknown id', async () => {
    getMock.mockResolvedValue(CANDIDATE);
    const ok = await request(buildApp()).get('/api/promotions/pc-1');
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe('pc-1');

    getMock.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/promotions/pc-nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/not found/);
  });
});

describe('POST /api/promotions/:id/promote', () => {
  it('takes the approver from the SESSION, not the request body', async () => {
    promoteMock.mockResolvedValue({ candidate: { ...CANDIDATE, status: 'promoted' } });
    const res = await request(buildApp())
      .post('/api/promotions/pc-1/promote')
      .send({ dryRunRunId: 'job:run-1', approvedBy: 'somebody-else' });
    expect(res.status).toBe(200);
    expect(promoteMock).toHaveBeenCalledWith('pc-1', { approvedBy: 'Priya Raman', dryRunRunId: 'job:run-1' });
    expect(res.body.status).toBe('promoted');
  });

  it('falls back to the session sub when the session carries no name', async () => {
    sessionValue = { sub: 'u-1' };
    promoteMock.mockResolvedValue({ candidate: CANDIDATE });
    await request(buildApp()).post('/api/promotions/pc-1/promote').send({});
    expect((promoteMock.mock.calls[0]![1] as { approvedBy: string }).approvedBy).toBe('u-1');
  });

  it('omits dryRunRunId when it was not supplied, and ignores a client-asserted dryRunPassed', async () => {
    promoteMock.mockResolvedValue({ candidate: CANDIDATE });
    await request(buildApp()).post('/api/promotions/pc-1/promote').send({ dryRunPassed: true });
    // A boolean is not a run: the provider judges the recorded dry-run instead.
    expect(promoteMock.mock.calls[0]![1]).toEqual({ approvedBy: 'Priya Raman' });
  });

  it('400s a non-string dryRunRunId before touching the provider', async () => {
    const res = await request(buildApp())
      .post('/api/promotions/pc-1/promote').send({ dryRunRunId: 42 });
    expect(res.status).toBe(400);
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('409s a gate refusal, naming the reason, and 404s an unknown id', async () => {
    promoteMock.mockResolvedValue({ error: 'a skill needs a passing dry run' });
    const refused = await request(buildApp()).post('/api/promotions/pc-1/promote').send({});
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'a skill needs a passing dry run' });

    promoteMock.mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/promotions/pc-x/promote').send({})).status).toBe(404);
  });
});

describe('POST /api/promotions/:id/dismiss', () => {
  it('requires a non-blank reason', async () => {
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await request(buildApp()).post('/api/promotions/pc-1/dismiss').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason/);
    }
    expect(dismissMock).not.toHaveBeenCalled();
  });

  it('trims the reason and returns the updated candidate', async () => {
    dismissMock.mockResolvedValue({ ...CANDIDATE, status: 'dismissed' });
    const res = await request(buildApp())
      .post('/api/promotions/pc-1/dismiss').send({ reason: '  duplicate of pc-0  ' });
    expect(res.status).toBe(200);
    expect(dismissMock).toHaveBeenCalledWith('pc-1', 'duplicate of pc-0');
    expect(res.body.status).toBe('dismissed');
  });

  it('404s an unknown id', async () => {
    dismissMock.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/promotions/pc-x/dismiss').send({ reason: 'x' });
    expect(res.status).toBe(404);
  });
});
