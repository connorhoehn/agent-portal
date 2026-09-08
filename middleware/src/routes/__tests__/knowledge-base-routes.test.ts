// KB management — /api/knowledge-base (routes/knowledge-base.ts).
//
// What is pinned:
//   * the auth floor: the two reads are open (this router is mounted with no
//     capability gate), the SYNC is gated on ManageKB because it spends real
//     Bedrock/OpenSearch resources,
//   * `total` is the count of the documents shipped beside it, never an
//     independently authored number (contract.ts bug class 1),
//   * the limit clamp (1..500, default 50, non-numeric falls back) and the
//     `since` passthrough,
//   * the sync failure branch: a 500 with `ok: false` and the underlying
//     message, rather than an unhandled throw — the admin page shows the
//     reason.

const gateCalls: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../config.js', () => ({
  config: { knowledgeBase: { id: 'kb-test' } },
}));
jest.mock('../../providers/knowledge-base.js', () => ({
  listIngestedDocs: jest.fn(),
  listDataSourcesWithStatus: jest.fn(),
  startSync: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { knowledgeBaseRouter } from '../knowledge-base.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listIngestedDocs, listDataSourcesWithStatus, startSync,
} from '../../providers/knowledge-base.js';

const docsMock = listIngestedDocs as unknown as jest.Mock;
const sourcesMock = listDataSourcesWithStatus as unknown as jest.Mock;
const syncMock = startSync as unknown as jest.Mock;

const DOC = {
  id: 'd-1', title: 'ADR 14', source: 'adr', sourceUri: 's3://x/adr-14.md',
  ingestedAt: '2026-08-20T09:00:00Z',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/knowledge-base', knowledgeBaseRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  docsMock.mockReset(); sourcesMock.mockReset(); syncMock.mockReset();
});

describe('auth floor', () => {
  it('gates only the sync, on ManageKB', () => {
    expect(gateCalls).toEqual(['ManageKB']);
  });
});

describe('GET /api/knowledge-base/documents', () => {
  it('reports a total that COUNTS the rows it ships', async () => {
    docsMock.mockResolvedValue([DOC, { ...DOC, id: 'd-2' }]);
    const res = await request(buildApp()).get('/api/knowledge-base/documents');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['documents', 'total']);
    expect(res.body.total).toBe(res.body.documents.length);
    expect(res.body.documents[0].sourceUri).toBe('s3://x/adr-14.md');
  });

  it('defaults to 50 and clamps the limit into 1..500', async () => {
    docsMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/knowledge-base/documents');
    await request(app).get('/api/knowledge-base/documents?limit=0');
    await request(app).get('/api/knowledge-base/documents?limit=9999');
    await request(app).get('/api/knowledge-base/documents?limit=abc');
    expect(docsMock.mock.calls.map((c) => (c[0] as { limit: number }).limit))
      .toEqual([50, 50, 500, 50]);
  });

  it('passes `since` through, and undefined when absent', async () => {
    docsMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/knowledge-base/documents?since=2026-08-01T00:00:00Z');
    await request(app).get('/api/knowledge-base/documents');
    expect((docsMock.mock.calls[0]![0] as { since?: string }).since).toBe('2026-08-01T00:00:00Z');
    expect((docsMock.mock.calls[1]![0] as { since?: string }).since).toBeUndefined();
  });

  it('serves an un-ingested corpus as an empty list with total 0', async () => {
    docsMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/knowledge-base/documents');
    expect(res.body).toEqual({ documents: [], total: 0 });
  });
});

describe('GET /api/knowledge-base/data-sources', () => {
  it('wraps the sources and asks about the CONFIGURED knowledge base', async () => {
    sourcesMock.mockResolvedValue([{ id: 'ds-1', name: 'documents', status: 'AVAILABLE', latestJob: null }]);
    const res = await request(buildApp()).get('/api/knowledge-base/data-sources');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['sources']);
    expect(sourcesMock).toHaveBeenCalledWith('kb-test');
    expect(res.body.sources[0]).toHaveProperty('latestJob');
  });
});

describe('POST /api/knowledge-base/sync', () => {
  it('400s a missing or non-string dataSourceId before spending anything', async () => {
    for (const body of [{}, { dataSourceId: '' }, { dataSourceId: '   ' }, { dataSourceId: 7 }]) {
      const res = await request(buildApp()).post('/api/knowledge-base/sync').send(body);
      expect(res.status).toBe(400);
    }
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('starts the job against the configured KB and returns its id', async () => {
    syncMock.mockResolvedValue({ jobId: 'job-9' });
    const res = await request(buildApp())
      .post('/api/knowledge-base/sync').send({ dataSourceId: '  ds-1  ' });
    expect(res.status).toBe(200);
    expect(syncMock).toHaveBeenCalledWith('kb-test', 'ds-1');
    expect(res.body).toEqual({ ok: true, jobId: 'job-9' });
  });

  it('reports a Bedrock failure as a 500 that NAMES it, with ok:false', async () => {
    syncMock.mockRejectedValue(new Error('ResourceNotFoundException: no such data source'));
    const res = await request(buildApp())
      .post('/api/knowledge-base/sync').send({ dataSourceId: 'ds-1' });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/ResourceNotFoundException/);
  });
});
