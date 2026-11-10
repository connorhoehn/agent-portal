// Session bundles — GET /api/session-bundle/live (routes/session-bundle.ts).
//
// `sessionsAffected` is recomputed against the CURRENT fleet on every read,
// not read off the stored row.

jest.mock('../../providers/session-bundle.js', () => ({
  getLiveBundle: jest.fn(),
  sessionsAffected: jest.fn(),
}));
jest.mock('../../lib/devbox-fleet.js', () => ({ listBoxes: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionBundleRouter } from '../session-bundle.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getLiveBundle, sessionsAffected } from '../../providers/session-bundle.js';
import { listBoxes } from '../../lib/devbox-fleet.js';

const liveMock = getLiveBundle as unknown as jest.Mock;
const affectedMock = sessionsAffected as unknown as jest.Mock;
const boxesMock = listBoxes as unknown as jest.Mock;

// A stale `sessionsAffected` baked into the row: the route must overwrite it.
const BUNDLE = {
  id: 'sb-3', status: 'live', publishedAt: '2026-08-20T09:00:00Z',
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
  liveMock.mockReset(); affectedMock.mockReset(); boxesMock.mockReset();
  boxesMock.mockReturnValue([{ id: 'box-1' }, { id: 'box-2' }]);
  affectedMock.mockReturnValue(2);
});

describe('GET /api/session-bundle/live', () => {
  it('stamps the live bundle with a live-fleet impact count', async () => {
    liveMock.mockResolvedValue({ ...BUNDLE, status: 'live' });
    const res = await request(buildApp()).get('/api/session-bundle/live');
    expect(res.status).toBe(200);
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
