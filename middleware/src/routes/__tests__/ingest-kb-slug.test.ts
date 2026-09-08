// `?kbSlug=` on the ingest routes — the second knowledge base is real, or the
// parameter refuses.
//
// THE BUG THIS PINS. `POST /api/ingest/start` accepted a `kbSlug`, resolved it
// against the `knowledge_bases` registry, and then called
// `startIngestionJob(entry.dataSourceId, description)` — which read its
// knowledgeBaseId from `config.knowledgeBase.id` and accepted no override. So
// asking to sync `orgiq-onboarding` returned `{ ok: true }` after issuing
// StartIngestionJob against `orgiq-default`. Worse, a slug that resolved to
// nothing, or to a row missing bedrock_kb_id or data_source_id, *fell through*
// to the single-KB path and synced the configured KB under the caller's name
// for a different one. Syncing the wrong corpus and reporting success is a
// strictly worse failure than refusing, so:
//
//   - `startIngestionJob` takes a kbId override and reports back the KB the job
//     actually ran against;
//   - every way the slug can fail to resolve refuses with the reason named,
//     and nothing falls through to the configured KB.
//
// `/queue` and `/storage` had the same defect in read-only form: both resolved
// the slug and discarded it (`const _entry = ...; // TODO Wave 2`), returning
// whole-bucket numbers labelled with one KB's name. Both now scope by the
// registry row's `s3_prefix`.
//
// The fixture makes this checkable: mock/kb-registry.ts seeds `orgiq-default`
// (the configured KB), `orgiq-onboarding` (a genuine second KB with its own
// data source) and `orgiq-legacy` (bedrock_kb_id set, data_source_id null —
// the row CLAUDE.md warns about, where repointing bedrock_kb_id alone leaves
// something that still rejects every sync).

// Both of these resolve a state file via `import.meta.url`, which ts-jest's
// CommonJS transform rejects outright — and neither has anything to do with
// what is under test here.
jest.mock('../../lib/ingest-scheduler.js', () => ({
  listSchedules: () => [],
  addSchedule: jest.fn(),
  removeSchedule: jest.fn(),
  toggleSchedule: jest.fn(),
  validateCronExpr: () => true,
}));
jest.mock('../../lib/crawl-targets.js', () => ({
  listCrawlTargets: () => [],
  getCrawlTarget: jest.fn(),
  addCrawlTarget: jest.fn(),
  updateCrawlTarget: jest.fn(),
  removeCrawlTarget: jest.fn(),
  recordTargetRun: jest.fn(),
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    knowledgeBase: { id: 'KBMOCK0001AB', serviceRoleArn: '' },
    foundation: { documentsBucket: '' },
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { ingestRouter } from '../ingest.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ingest', ingestRouter);
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  fixtureRegistry.resetAll('default');
  execMock.mockReset();
});

describe('POST /api/ingest/start?kbSlug', () => {
  it('syncs the KB the slug names, not the configured one', async () => {
    const res = await request(buildApp())
      .post('/api/ingest/start')
      .send({ kbSlug: 'orgiq-onboarding' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(execMock).not.toHaveBeenCalled();
    // The whole point: the second KB's id, not KBMOCK0001AB from config.
    expect(res.body.knowledgeBaseId).toBe('KBMOCK0002CD');
    expect(res.body.job.knowledgeBaseId).toBe('KBMOCK0002CD');
    expect(res.body.job.dataSourceId).toBe('DSMOCK0002CD');
    expect(res.body.kbSlug).toBe('orgiq-onboarding');
  });

  it('still honours the configured KB for its own slug', async () => {
    const res = await request(buildApp())
      .post('/api/ingest/start')
      .send({ kbSlug: 'orgiq-default' });

    expect(res.status).toBe(200);
    expect(res.body.knowledgeBaseId).toBe('KBMOCK0001AB');
    expect(res.body.job.dataSourceId).toBe('DSMOCK0001AB');
  });

  it('404s an unregistered slug instead of syncing the configured KB', async () => {
    const res = await request(buildApp())
      .post('/api/ingest/start')
      .send({ kbSlug: 'no-such-kb' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no-such-kb/);
    expect(res.body.ok).toBeUndefined();
  });

  it('409s a row with a KB id but no data source, naming the remedy', async () => {
    const res = await request(buildApp())
      .post('/api/ingest/start')
      .send({ kbSlug: 'orgiq-legacy' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/data_source_id/);
    expect(res.body.error).toMatch(/admin\/knowledge/);
  });

  it('leaves the no-slug path alone — dataSourceId still required', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/ingest/start').send({})).status).toBe(400);

    const ok = await request(app).post('/api/ingest/start').send({ dataSourceId: 'DSMOCK0001AB' });
    expect(ok.status).toBe(200);
    expect(ok.body.knowledgeBaseId).toBe('KBMOCK0001AB');
  });
});

describe('kbSlug on the read routes', () => {
  it('scopes /queue to the KB prefix and says which prefix it counted', async () => {
    const app = buildApp();
    const all = await request(app).get('/api/ingest/queue');
    const scoped = await request(app).get('/api/ingest/queue?kbSlug=orgiq-onboarding');

    expect(all.status).toBe(200);
    expect(scoped.status).toBe(200);
    expect(all.body.total).toBeGreaterThan(0);
    expect(scoped.body.total).toBeLessThan(all.body.total);
    // The label is what keeps a zero honest: "nothing under orgiq-onboarding/"
    // is a claim about a prefix, not about a knowledge base.
    expect(scoped.body.kbSlug).toBe('orgiq-onboarding');
    expect(scoped.body.s3Prefix).toBe('orgiq-onboarding/');
    // The unscoped shape is untouched — that is what the portal actually calls.
    expect(all.body.kbSlug).toBeUndefined();
    expect(all.body.s3Prefix).toBeUndefined();
  });

  it('scopes /storage the same way', async () => {
    const app = buildApp();
    const all = await request(app).get('/api/ingest/storage');
    const scoped = await request(app).get('/api/ingest/storage?kbSlug=orgiq-onboarding');

    expect(all.body.totalObjects).toBeGreaterThan(0);
    expect(scoped.body.totalObjects).toBeLessThan(all.body.totalObjects);
    expect(scoped.body.s3Prefix).toBe('orgiq-onboarding/');
    expect(all.body.s3Prefix).toBeUndefined();
  });

  it('404s an unregistered slug on both read routes', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/ingest/queue?kbSlug=nope')).status).toBe(404);
    expect((await request(app).get('/api/ingest/storage?kbSlug=nope')).status).toBe(404);
  });
});
