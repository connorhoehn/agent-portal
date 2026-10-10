// Session bundles — /api/session-bundle (routes/session-bundle.ts).
//
// What is pinned:
//   * `sessionsAffected` is recomputed against the CURRENT fleet on every
//     single-bundle read, not read off the stored row. "Publishing blind" is
//     the failure this field exists to prevent, and a cached count is exactly
//     the bug it would reintroduce (contract.ts bug class 1: a stored number
//     next to rows that moved),
//   * the route ORDER — `/live` is a literal that must win over `/:id`,
//   * the auth floor: three open reads, publish on ManageDevbox,
//   * `hasHooks` is derived from whether a dry-run box was actually named —
//     the route's stated proxy — and the approver comes from the session,
//   * the 409 (refused publish, reason relayed) and 404 (unknown id) branches.

const gateCalls: string[] = [];
let sessionValue: { sub: string; name?: string } | null = { sub: 'u-1', name: 'Ops' };

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  resolveSession: () => sessionValue,
}));

jest.mock('../../providers/session-bundle.js', () => ({
  listBundles: jest.fn(),
  getLiveBundle: jest.fn(),
  getBundle: jest.fn(),
  publishBundle: jest.fn(),
  sessionsAffected: jest.fn(),
}));
jest.mock('../../lib/devbox-fleet.js', () => ({ listBoxes: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionBundleRouter } from '../session-bundle.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listBundles, getLiveBundle, getBundle, publishBundle, sessionsAffected,
} from '../../providers/session-bundle.js';
import { listBoxes } from '../../lib/devbox-fleet.js';

const listMock = listBundles as unknown as jest.Mock;
const liveMock = getLiveBundle as unknown as jest.Mock;
const getMock = getBundle as unknown as jest.Mock;
const publishMock = publishBundle as unknown as jest.Mock;
const affectedMock = sessionsAffected as unknown as jest.Mock;
const boxesMock = listBoxes as unknown as jest.Mock;

// A stale `sessionsAffected` baked into the row: the route must overwrite it.
const BUNDLE = {
  id: 'sb-3', status: 'pending', publishedAt: '2026-08-20T09:00:00Z',
  publishedBy: 'Ops', hooks: [], skills: [], sessionsAffected: 999,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/session-bundle', sessionBundleRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  listMock.mockReset(); liveMock.mockReset(); getMock.mockReset();
  publishMock.mockReset(); affectedMock.mockReset(); boxesMock.mockReset();
  boxesMock.mockReturnValue([{ id: 'box-1' }, { id: 'box-2' }]);
  affectedMock.mockReturnValue(2);
  sessionValue = { sub: 'u-1', name: 'Ops' };
});

describe('auth floor', () => {
  it('gates only publish, on ManageDevbox', () => {
    expect(gateCalls).toEqual(['ManageDevbox']);
  });
});

describe('GET /api/session-bundle', () => {
  it('wraps the list and stamps every row with a LIVE-fleet impact count', async () => {
    listMock.mockResolvedValue([BUNDLE, { ...BUNDLE, id: 'sb-2' }]);
    const res = await request(buildApp()).get('/api/session-bundle');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['bundles']);
    // The stale 999 on the row is replaced, and the count is computed from
    // listBoxes() — the fleet as it is now.
    expect(res.body.bundles.map((b: { sessionsAffected: number }) => b.sessionsAffected)).toEqual([2, 2]);
    expect(affectedMock).toHaveBeenCalledTimes(2);
    expect(affectedMock.mock.calls[0]![1]).toEqual([{ id: 'box-1' }, { id: 'box-2' }]);
  });

  it('serves an empty fleet-config history as an empty list', async () => {
    listMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/session-bundle');
    expect(res.body).toEqual({ bundles: [] });
    expect(affectedMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/session-bundle/live', () => {
  it('resolves as a literal, ahead of /:id', async () => {
    liveMock.mockResolvedValue({ ...BUNDLE, status: 'live' });
    const res = await request(buildApp()).get('/api/session-bundle/live');
    expect(res.status).toBe(200);
    // Ambiguity here would have called getBundle('live').
    expect(getMock).not.toHaveBeenCalled();
    expect(res.body.status).toBe('live');
    expect(res.body.sessionsAffected).toBe(2);
  });

  it('answers null, not a 404, when nothing is live yet', async () => {
    liveMock.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/session-bundle/live');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe('GET /api/session-bundle/:id', () => {
  it('returns one bundle with a recomputed impact, and 404s an unknown id', async () => {
    affectedMock.mockReturnValue(5);
    getMock.mockResolvedValue(BUNDLE);
    const ok = await request(buildApp()).get('/api/session-bundle/sb-3');
    expect(ok.status).toBe(200);
    expect(ok.body.sessionsAffected).toBe(5);

    getMock.mockResolvedValue(null);
    expect((await request(buildApp()).get('/api/session-bundle/sb-x')).status).toBe(404);
  });
});

describe('POST /api/session-bundle/:id/publish', () => {
  it('derives hasHooks from a named dry-run box and names the session as approver', async () => {
    publishMock.mockResolvedValue({ ok: true, bundle: { ...BUNDLE, status: 'live' } });
    const res = await request(buildApp())
      .post('/api/session-bundle/sb-3/publish').send({ dryRunBoxId: '  box-1  ' });
    expect(res.status).toBe(200);
    expect(publishMock).toHaveBeenCalledWith('sb-3', {
      approvedBy: 'Ops', dryRunBoxId: 'box-1', hasHooks: true,
    });
    expect(res.body.sessionsAffected).toBe(2);
  });

  it('publishes with hasHooks false and a null box when no dry run was named', async () => {
    publishMock.mockResolvedValue({ ok: true, bundle: BUNDLE });
    await request(buildApp()).post('/api/session-bundle/sb-3/publish').send({});
    expect(publishMock).toHaveBeenCalledWith('sb-3', {
      approvedBy: 'Ops', dryRunBoxId: null, hasHooks: false,
    });
  });

  it('sends a null approver when there is no session rather than inventing one', async () => {
    sessionValue = null;
    publishMock.mockResolvedValue({ ok: true, bundle: BUNDLE });
    await request(buildApp()).post('/api/session-bundle/sb-3/publish').send({});
    expect((publishMock.mock.calls[0]![1] as { approvedBy: string | null }).approvedBy).toBeNull();
  });

  it('409s a refused publish with the decision\'s own reason, and 404s an unknown id', async () => {
    publishMock.mockResolvedValue({ ok: false, reason: 'no dry run confirmed the hook fired' });
    const refused = await request(buildApp()).post('/api/session-bundle/sb-3/publish').send({});
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'no dry run confirmed the hook fired' });

    publishMock.mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/session-bundle/sb-x/publish').send({})).status).toBe(404);
  });
});
