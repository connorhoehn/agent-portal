// Ingest — /api/ingest (routes/ingest.ts). The KB/job surface, the schedule
// CRUD, the crawler, the crawl-target registry, and the site survey.
//
// (`/queue`, `/start` and `/storage` have their own suite — see
// ingest-kb-slug.test.ts, which pins the "never sync the wrong corpus" rule.)
//
// What is pinned here:
//   * every wire envelope the Ingest pages destructure (`{kb,state,kbId,
//     problem}`, `{sources}`, `{jobs}`, `{job}`, `{schedules}`, `{crawls}`,
//     `{session}`, `{targets}`, `{target}`, `{surveys}`) — a renamed key is
//     invisible until a page renders blank,
//   * the diagnosis on /kb: "not configured" and "configured but deleted
//     upstream" need different operator action, so `state` and `problem` ride
//     along with the payload rather than collapsing to a null kb,
//   * the CREATED/ACCEPTED statuses (201 for a created schedule/target/upload,
//     202 for work that has only been STARTED) — a 200 would tell the portal
//     the crawl had finished,
//   * validation before side effects: a bad URL, a bad cron, a missing label
//     all refuse without registering anything,
//   * the survey → target rule the whole feature turns on: the include pattern
//     is anchored on the PATHNAME and regex-escaped. An origin-anchored
//     pattern matched nothing, so every survey-created target crawled its
//     start URL and stopped,
//   * the two SSE routes' non-streaming branches (400 for a stream with no
//     job, 404 for an unknown crawl, and immediate close on a terminal one).

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    foundation: { documentsBucket: 'orgiq-documents-test' },
    mock: { aurora: false },
  },
}));
jest.mock('../../providers/knowledge-base.js', () => ({
  getKb: jest.fn(), lookupKb: jest.fn(), listDataSources: jest.fn(),
  listIngestionJobs: jest.fn(), getIngestionJob: jest.fn(), startIngestionJob: jest.fn(),
  countS3Documents: jest.fn(), uploadDocument: jest.fn(), getIngestStats: jest.fn(),
  triggerKbSyncForCrawl: jest.fn(), getStorageBreakdown: jest.fn(),
}));
jest.mock('../../providers/kb-registry.js', () => ({ getKbBySlug: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({
  listSchedules: jest.fn(), addSchedule: jest.fn(), removeSchedule: jest.fn(),
  toggleSchedule: jest.fn(), validateCronExpr: jest.fn(),
}));
jest.mock('../../lib/crawler.js', () => ({
  startCrawl: jest.fn(), getCrawl: jest.fn(), listCrawls: jest.fn(),
  cancelCrawl: jest.fn(), subscribeCrawl: jest.fn(),
}));
jest.mock('../../lib/crawl-targets.js', () => ({
  listCrawlTargets: jest.fn(), getCrawlTarget: jest.fn(), addCrawlTarget: jest.fn(),
  updateCrawlTarget: jest.fn(), removeCrawlTarget: jest.fn(), recordTargetRun: jest.fn(),
}));
jest.mock('../../lib/site-survey.js', () => ({
  startSurvey: jest.fn(), getSurvey: jest.fn(), listSurveys: jest.fn(),
}));
const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { send(cmd: unknown) { return s3Send(cmd); } },
  GetObjectCommand: class { constructor(public readonly input: unknown) {} },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { ingestRouter } from '../ingest.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  lookupKb, listDataSources, listIngestionJobs, getIngestionJob,
  uploadDocument, getIngestStats, triggerKbSyncForCrawl,
} from '../../providers/knowledge-base.js';
import {
  listSchedules, addSchedule, removeSchedule, toggleSchedule, validateCronExpr,
} from '../../lib/ingest-scheduler.js';
import { startCrawl, getCrawl, listCrawls, cancelCrawl, subscribeCrawl } from '../../lib/crawler.js';
import {
  listCrawlTargets, getCrawlTarget, addCrawlTarget, updateCrawlTarget,
  removeCrawlTarget, recordTargetRun,
} from '../../lib/crawl-targets.js';
import { startSurvey, getSurvey, listSurveys } from '../../lib/site-survey.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

function crawlSession(over: Record<string, unknown> = {}) {
  return {
    id: 'cr-1', startUrl: 'https://docs.example.com', status: 'running',
    label: 'docs', pages: [
      { url: 'https://docs.example.com/a', title: 'A', status: 200, s3ScreenshotKey: null, s3MarkdownKey: null, s3AnalysisKey: null },
    ],
    ...over,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ingest', ingestRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(validateCronExpr).mockReturnValue(true);
  m(subscribeCrawl).mockReturnValue(() => {});
});

// ── KB + jobs ──────────────────────────────────────────────────────────────

describe('GET /api/ingest/kb', () => {
  it('ships the DIAGNOSIS beside the payload, not just a null kb', async () => {
    // "never configured" and "configured but deleted upstream" need different
    // operator action, so state/problem travel with the kb.
    m(lookupKb).mockResolvedValue({
      kb: null, state: 'missing', kbId: 'kb-old',
      problem: 'KNOWLEDGE_BASE_ID points at a knowledge base that no longer exists',
    });
    const res = await request(buildApp()).get('/api/ingest/kb');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['kb', 'kbId', 'problem', 'state']);
    expect(res.body.kb).toBeNull();
    expect(res.body.state).toBe('missing');
    expect(res.body.problem).toMatch(/no longer exists/);
  });

  it('reports a healthy KB with no problem', async () => {
    m(lookupKb).mockResolvedValue({
      kb: { knowledgeBaseId: 'kb-1', name: 'orgiq' }, state: 'ok', kbId: 'kb-1', problem: null,
    });
    const res = await request(buildApp()).get('/api/ingest/kb');
    expect(res.body.state).toBe('ok');
    expect(res.body.problem).toBeNull();
  });
});

describe('GET /api/ingest/data-sources', () => {
  it('wraps the data sources', async () => {
    m(listDataSources).mockResolvedValue([{ dataSourceId: 'ds-1', name: 'documents' }]);
    const res = await request(buildApp()).get('/api/ingest/data-sources');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['sources']);
    expect(res.body.sources[0].dataSourceId).toBe('ds-1');
  });

  // The failure this pair of tests exists for: the provider used to swallow a
  // refused ListDataSources into `[]`, so "Bedrock said no" and "this
  // knowledge base has no data sources attached" were the same answer — and
  // the page says the reassuring one. The route now asks for the throw and
  // marks the empty body it answers with.
  it('marks a failed listing degraded rather than answering an empty list', async () => {
    m(listDataSources).mockRejectedValue(new Error('AccessDeniedException: not authorized'));
    const res = await request(buildApp()).get('/api/ingest/data-sources');
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([]);
    expect(res.body.degraded).toBe(true);
    expect(res.body.error).toMatch(/AccessDeniedException/);
  });
});

describe('GET /api/ingest/jobs', () => {
  it('wraps the jobs and defaults the limit to 20 with no data-source filter', async () => {
    m(listIngestionJobs).mockResolvedValue([{ jobId: 'j-1', status: 'COMPLETE' }]);
    const res = await request(buildApp()).get('/api/ingest/jobs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['jobs']);
    expect(listIngestionJobs).toHaveBeenCalledWith(undefined, 20, { silent: false });
  });

  it('clamps the limit into 1..100 and forwards the data source', async () => {
    m(listIngestionJobs).mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/ingest/jobs?limit=1&dataSourceId=ds-1');
    await request(app).get('/api/ingest/jobs?limit=9999');
    await request(app).get('/api/ingest/jobs?limit=abc');
    // `limit=0` clamps to 1. It used to read as "absent" and return 20,
    // because the parse was spelled `parseInt(...) || 20` and 0 is falsy.
    await request(app).get('/api/ingest/jobs?limit=0');
    expect(m(listIngestionJobs).mock.calls.map((c) => c[1])).toEqual([1, 100, 20, 1]);
    expect(m(listIngestionJobs).mock.calls[0]![0]).toBe('ds-1');
  });

  // Same shape as the data-sources case: an unmarked empty list here reads as
  // "this knowledge base has never synced", which is the opposite diagnosis
  // from "Bedrock refused the listing".
  it('marks a failed job listing degraded rather than answering an empty list', async () => {
    m(listIngestionJobs).mockRejectedValue(new Error('ThrottlingException: rate exceeded'));
    const res = await request(buildApp()).get('/api/ingest/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.degraded).toBe(true);
    expect(res.body.error).toMatch(/ThrottlingException/);
  });
});

describe('GET /api/ingest/job/:jobId', () => {
  it('400s without a dataSourceId — GetIngestionJob needs the pair', async () => {
    const res = await request(buildApp()).get('/api/ingest/job/j-1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dataSourceId/);
    expect(getIngestionJob).not.toHaveBeenCalled();
  });

  it('returns the job, and 404s one that does not exist', async () => {
    m(getIngestionJob).mockResolvedValue({ jobId: 'j-1', status: 'IN_PROGRESS' });
    const ok = await request(buildApp()).get('/api/ingest/job/j-1?dataSourceId=ds-1');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body)).toEqual(['job']);
    expect(getIngestionJob).toHaveBeenCalledWith('j-1', 'ds-1');

    m(getIngestionJob).mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/ingest/job/j-9?dataSourceId=ds-1');
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/ingest/stream', () => {
  it('400s as plain JSON — before opening a stream — when the pair is incomplete', async () => {
    const app = buildApp();
    for (const url of ['/api/ingest/stream', '/api/ingest/stream?jobId=j-1', '/api/ingest/stream?dataSourceId=ds-1']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/jobId and dataSourceId/);
      expect(res.headers['content-type']).toMatch(/json/);
    }
  });

  it('emits update then done and CLOSES on a terminal job, rather than polling on', async () => {
    m(getIngestionJob).mockResolvedValue({ jobId: 'j-1', status: 'COMPLETE' });
    const res = await request(buildApp()).get('/api/ingest/stream?jobId=j-1&dataSourceId=ds-1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/"type":"update"/);
    expect(res.text).toMatch(/"type":"done"/);
    // One poll, not a 3-second retry loop.
    expect(getIngestionJob).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/ingest/stats', () => {
  it('passes the stats rollup through', async () => {
    m(getIngestStats).mockResolvedValue({
      s3: { totalObjects: 163, byExtension: { '.md': 163 } },
      recentJobs: [], kb: { status: 'ACTIVE' },
    });
    const res = await request(buildApp()).get('/api/ingest/stats');
    expect(res.status).toBe(200);
    expect(res.body.s3.totalObjects).toBe(163);
    expect(res.body.recentJobs).toEqual([]);
  });
});

// ── Schedules ──────────────────────────────────────────────────────────────

describe('schedule CRUD', () => {
  it('GET /schedules wraps the list', async () => {
    m(listSchedules).mockReturnValue([{ id: 'sc-1', cronExpr: '0 * * * *', enabled: true }]);
    const res = await request(buildApp()).get('/api/ingest/schedules');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['schedules']);
  });

  it('POST /schedules 400s without a dataSourceId or cron, and on an invalid cron', async () => {
    const app = buildApp();
    const missing = await request(app).post('/api/ingest/schedules').send({ dataSourceId: 'ds-1' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/dataSourceId and cronExpr/);

    m(validateCronExpr).mockReturnValue(false);
    const badCron = await request(app).post('/api/ingest/schedules')
      .send({ dataSourceId: 'ds-1', cronExpr: 'every tuesday-ish' });
    expect(badCron.status).toBe(400);
    expect(badCron.body.error).toMatch(/Invalid cron expression: every tuesday-ish/);
    expect(addSchedule).not.toHaveBeenCalled();
  });

  it('POST /schedules answers 201 and defaults name/label/enabled', async () => {
    m(addSchedule).mockReturnValue({ id: 'sc-2' });
    const res = await request(buildApp()).post('/api/ingest/schedules')
      .send({ dataSourceId: 'ds-1', cronExpr: '0 3 * * *' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['schedule']);
    expect(addSchedule).toHaveBeenCalledWith({
      dataSourceId: 'ds-1', dataSourceName: 'ds-1', cronExpr: '0 3 * * *',
      label: '0 3 * * *', enabled: true,
    });
  });

  it('POST /schedules honours enabled:false, and only that exact value', async () => {
    m(addSchedule).mockReturnValue({ id: 'sc-3' });
    const app = buildApp();
    await request(app).post('/api/ingest/schedules')
      .send({ dataSourceId: 'ds-1', cronExpr: '0 3 * * *', enabled: false });
    await request(app).post('/api/ingest/schedules')
      .send({ dataSourceId: 'ds-1', cronExpr: '0 3 * * *', enabled: true });
    expect(m(addSchedule).mock.calls.map((c) => (c[0] as { enabled: boolean }).enabled))
      .toEqual([false, true]);
  });

  it('DELETE /schedules/:id 404s an unknown id and 200s a removal', async () => {
    m(removeSchedule).mockReturnValue(false);
    const missing = await request(buildApp()).delete('/api/ingest/schedules/sc-x');
    expect(missing.status).toBe(404);

    m(removeSchedule).mockReturnValue(true);
    const ok = await request(buildApp()).delete('/api/ingest/schedules/sc-1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
  });

  it('PATCH /schedules/:id/toggle demands a real boolean', async () => {
    const app = buildApp();
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }]) {
      const res = await request(app).patch('/api/ingest/schedules/sc-1/toggle').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled \(boolean\)/);
    }
    expect(toggleSchedule).not.toHaveBeenCalled();
  });

  it('PATCH /schedules/:id/toggle returns the updated schedule, 404s an unknown id', async () => {
    m(toggleSchedule).mockReturnValue({ id: 'sc-1', enabled: false });
    const ok = await request(buildApp()).patch('/api/ingest/schedules/sc-1/toggle').send({ enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.body.schedule.enabled).toBe(false);
    expect(toggleSchedule).toHaveBeenCalledWith('sc-1', false);

    m(toggleSchedule).mockReturnValue(null);
    const missing = await request(buildApp()).patch('/api/ingest/schedules/sc-x/toggle').send({ enabled: true });
    expect(missing.status).toBe(404);
  });
});

// ── Upload ─────────────────────────────────────────────────────────────────

describe('POST /api/ingest/upload', () => {
  it('requires the X-Filename header and a non-empty body', async () => {
    const app = buildApp();
    const noName = await request(app).post('/api/ingest/upload')
      .set('Content-Type', 'text/markdown').send('hello');
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/X-Filename/);

    const empty = await request(app).post('/api/ingest/upload')
      .set('X-Filename', 'a.md').set('Content-Type', 'text/markdown').send('');
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/Empty body/);
    expect(uploadDocument).not.toHaveBeenCalled();
  });

  it('uploads the raw bytes with the declared type, defaulting the prefix to uploads/', async () => {
    m(uploadDocument).mockResolvedValue({ key: 'uploads/a.md', bucket: 'orgiq-documents-test' });
    const res = await request(buildApp()).post('/api/ingest/upload')
      .set('X-Filename', '  a.md  ').set('Content-Type', 'text/markdown')
      .send('# hello');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, key: 'uploads/a.md', bucket: 'orgiq-documents-test' });
    const [filename, body, contentType, prefix] = m(uploadDocument).mock.calls[0]!;
    expect(filename).toBe('a.md');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(String(body)).toBe('# hello');
    expect(contentType).toMatch(/text\/markdown/);
    expect(prefix).toBe('uploads');
  });

  it('honours an explicit X-Prefix', async () => {
    m(uploadDocument).mockResolvedValue({ key: 'adr/a.md' });
    await request(buildApp()).post('/api/ingest/upload')
      .set('X-Filename', 'a.md').set('X-Prefix', ' adr ')
      .set('Content-Type', 'text/markdown').send('x');
    expect(m(uploadDocument).mock.calls[0]![3]).toBe('adr');
  });
});

// ── Crawl ──────────────────────────────────────────────────────────────────

describe('POST /api/ingest/crawl', () => {
  it('refuses a missing or unparseable startUrl before starting anything', async () => {
    const app = buildApp();
    const missing = await request(app).post('/api/ingest/crawl').send({});
    expect(missing.status).toBe(400);
    const bad = await request(app).post('/api/ingest/crawl').send({ startUrl: 'docs.example.com' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/valid URL/);
    expect(startCrawl).not.toHaveBeenCalled();
  });

  it('answers 202 ACCEPTED with the crawl id — the work has started, not finished', async () => {
    m(startCrawl).mockResolvedValue(crawlSession());
    const res = await request(buildApp()).post('/api/ingest/crawl')
      .send({ startUrl: 'https://docs.example.com', maxPages: 25, mode: 'browser' });
    expect(res.status).toBe(202);
    expect(res.body.crawlId).toBe('cr-1');
    expect(res.body.session.status).toBe('running');
  });
});

describe('crawl reads', () => {
  it('GET /crawls wraps the recent sessions, capped at 50', async () => {
    m(listCrawls).mockReturnValue([crawlSession()]);
    const res = await request(buildApp()).get('/api/ingest/crawls');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['crawls']);
    expect(listCrawls).toHaveBeenCalledWith(50);
  });

  it('GET /crawl/:id returns the session, 404s an unknown one', async () => {
    m(getCrawl).mockReturnValue(crawlSession());
    const ok = await request(buildApp()).get('/api/ingest/crawl/cr-1');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body)).toEqual(['session']);

    m(getCrawl).mockReturnValue(undefined);
    const missing = await request(buildApp()).get('/api/ingest/crawl/cr-x');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Crawl not found');
  });

  it('DELETE /crawl/:id cancels, and 404s when there was nothing to cancel', async () => {
    m(cancelCrawl).mockReturnValue(true);
    const ok = await request(buildApp()).delete('/api/ingest/crawl/cr-1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });

    m(cancelCrawl).mockReturnValue(false);
    expect((await request(buildApp()).delete('/api/ingest/crawl/cr-x')).status).toBe(404);
  });
});

describe('GET /api/ingest/crawl/:id/stream', () => {
  it('404s an unknown crawl as JSON rather than opening a stream', async () => {
    m(getCrawl).mockReturnValue(undefined);
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-x/stream');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(subscribeCrawl).not.toHaveBeenCalled();
  });

  it('sends the terminal state and closes immediately for a finished crawl', async () => {
    m(getCrawl).mockReturnValue(crawlSession({ status: 'completed' }));
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/"type":"completed"/);
    // No subscription for a crawl that is already over.
    expect(subscribeCrawl).not.toHaveBeenCalled();
  });
});

describe('crawl page artifacts', () => {
  it('404s an out-of-range or non-numeric page index', async () => {
    m(getCrawl).mockReturnValue(crawlSession());
    const app = buildApp();
    for (const idx of ['5', '-1', 'abc']) {
      const res = await request(app).get(`/api/ingest/crawl/cr-1/page/${idx}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Page not found');
    }
  });

  it('returns the in-memory page with a null analysis until the blob exists', async () => {
    m(getCrawl).mockReturnValue(crawlSession());
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['analysis', 'page']);
    expect(res.body.page.url).toBe('https://docs.example.com/a');
    expect(res.body.analysis).toBeNull();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('merges the S3 analysis blob when the page carries a key', async () => {
    m(getCrawl).mockReturnValue(crawlSession({
      pages: [{ url: 'u', title: 't', status: 200, s3AnalysisKey: 'crawled/cr-1/0.json' }],
    }));
    s3Send.mockResolvedValue({ Body: { transformToString: async () => '{"headings":3}' } });
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0');
    expect(res.body.analysis).toEqual({ headings: 3 });
  });

  it('keeps a non-JSON analysis blob as raw text instead of throwing', async () => {
    m(getCrawl).mockReturnValue(crawlSession({
      pages: [{ url: 'u', title: 't', status: 200, s3AnalysisKey: 'k' }],
    }));
    s3Send.mockResolvedValue({ Body: { transformToString: async () => 'not json' } });
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0');
    expect(res.body.analysis).toBe('not json');
  });

  it('still answers the page when the analysis fetch fails', async () => {
    m(getCrawl).mockReturnValue(crawlSession({
      pages: [{ url: 'u', title: 't', status: 200, s3AnalysisKey: 'k' }],
    }));
    s3Send.mockRejectedValue(new Error('AccessDenied'));
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0');
    expect(res.status).toBe(200);
    expect(res.body.analysis).toBeNull();
  });

  it('404s a screenshot the page never captured, without calling S3', async () => {
    m(getCrawl).mockReturnValue(crawlSession());
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0/screenshot');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Screenshot not available');
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('404s (not 500) when S3 refuses the screenshot', async () => {
    m(getCrawl).mockReturnValue(crawlSession({
      pages: [{ url: 'u', title: 't', status: 200, s3ScreenshotKey: 'shot.png' }],
    }));
    s3Send.mockRejectedValue(new Error('NoSuchKey'));
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0/screenshot');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Screenshot not found');
  });

  it('502s an empty S3 body rather than serving a zero-byte image', async () => {
    m(getCrawl).mockReturnValue(crawlSession({
      pages: [{ url: 'u', title: 't', status: 200, s3ScreenshotKey: 'shot.png' }],
    }));
    s3Send.mockResolvedValue({ ContentType: 'image/png', Body: undefined });
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/page/0/screenshot');
    expect(res.status).toBe(502);
    // The error is JSON and says so. It used to go out labelled image/png,
    // because Content-Type was set before the failure was known and res.json()
    // will not overwrite an existing one — a client parsing JSON saw nothing.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Empty S3 body' });
  });
});

describe('GET /api/ingest/crawl/:id/manifest', () => {
  it('reports a pageCount that COUNTS the entries it ships', async () => {
    m(getCrawl).mockReturnValue(crawlSession({
      pages: [
        { url: 'u1', title: 'A', status: 200, s3ScreenshotKey: 'a.png', s3MarkdownKey: 'a.md', s3AnalysisKey: null },
        { url: 'u2', title: 'B', status: 404, s3ScreenshotKey: null, s3MarkdownKey: null, s3AnalysisKey: null },
      ],
    }));
    const res = await request(buildApp()).get('/api/ingest/crawl/cr-1/manifest');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['bucket', 'crawlId', 'entries', 'pageCount', 'prefix']);
    expect(res.body.pageCount).toBe(res.body.entries.length);
    expect(res.body.entries[0]).toEqual({
      idx: 0, url: 'u1', title: 'A', status: 200,
      screenshotKey: 'a.png', markdownKey: 'a.md', analysisKey: null,
    });
    // Falls back to a derived prefix when the session has none.
    expect(res.body.prefix).toBe('crawled/cr-1');
    expect(res.body.bucket).toBe('orgiq-documents-test');
  });

  it('404s an unknown crawl', async () => {
    m(getCrawl).mockReturnValue(undefined);
    expect((await request(buildApp()).get('/api/ingest/crawl/cr-x/manifest')).status).toBe(404);
  });
});

describe('POST /api/ingest/crawl/:id/sync', () => {
  it('404s an unknown crawl, relays the provider\'s reason, 202s a started one', async () => {
    m(getCrawl).mockReturnValue(undefined);
    expect((await request(buildApp()).post('/api/ingest/crawl/cr-x/sync').send({})).status).toBe(404);

    m(getCrawl).mockReturnValue(crawlSession());
    // This route answered a flat 502 "StartIngestionJob failed — check
    // middleware logs" for every failure, because the provider collapsed every
    // exception to `null`. It now carries a status and a sentence, so the route
    // relays them instead of inventing one.
    m(triggerKbSyncForCrawl).mockResolvedValue({
      ok: false, status: 502, conflict: false,
      error: 'Could not start a sync on KB123: something broke',
    });
    const failed = await request(buildApp()).post('/api/ingest/crawl/cr-1/sync').send({});
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatch(/something broke/);

    m(triggerKbSyncForCrawl).mockResolvedValue({ ok: true, jobId: 'j-9', status: 'STARTING' });
    const ok = await request(buildApp()).post('/api/ingest/crawl/cr-1/sync').send({});
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ ok: true, job: { jobId: 'j-9', status: 'STARTING' } });
    expect(triggerKbSyncForCrawl).toHaveBeenCalledWith('cr-1');
  });

  it('a sync already running is a 409 that says so, not a 502 that blames the pipeline',
    async () => {
      // The case that made this a false flag: Bedrock refuses because the sync
      // the caller wants is ALREADY HAPPENING, and the platform reported a bad
      // gateway and told the operator to read server logs.
      m(getCrawl).mockReturnValue(crawlSession());
      m(triggerKbSyncForCrawl).mockResolvedValue({
        ok: false, status: 409, conflict: true,
        error: 'A sync is already running on KB123/DS456. Wait for it to finish — '
          + 'starting another job now would re-embed the same documents.',
      });
      const res = await request(buildApp()).post('/api/ingest/crawl/cr-1/sync').send({});
      expect(res.status).toBe(409);
      expect(res.body.conflict).toBe(true);
      expect(res.body.error).toMatch(/already running/i);
      // `conflict` reaches the wire so the portal can render this as a state
      // rather than colouring it as an error.
      expect(res.body.error).not.toMatch(/middleware logs/i);
    });
});

// ── Crawl targets ──────────────────────────────────────────────────────────

describe('crawl targets', () => {
  it('GET /crawl-targets wraps the registry', async () => {
    m(listCrawlTargets).mockReturnValue([{ id: 'ct-1', label: 'docs' }]);
    const res = await request(buildApp()).get('/api/ingest/crawl-targets');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['targets']);
  });

  it('POST /crawl-targets validates url, label and cron before registering', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/ingest/crawl-targets').send({})).body.error).toMatch(/startUrl/);
    expect((await request(app).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'nope' })).body.error).toMatch(/valid URL/);
    expect((await request(app).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'https://a.example.com' })).body.error).toMatch(/label required/);

    m(validateCronExpr).mockReturnValue(false);
    const badCron = await request(app).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'https://a.example.com', label: 'a', cronExpr: 'nope' });
    expect(badCron.status).toBe(400);
    expect(addCrawlTarget).not.toHaveBeenCalled();
  });

  it('POST /crawl-targets 201s with clamped maxPages and browser-by-default', async () => {
    m(addCrawlTarget).mockReturnValue({ id: 'ct-2' });
    const app = buildApp();
    await request(app).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'https://a.example.com', label: 'a' });
    await request(app).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'https://a.example.com', label: 'a', maxPages: 9999 });
    await request(app).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'https://a.example.com', label: 'a', maxPages: 0 });

    const calls = m(addCrawlTarget).mock.calls.map((c) => c[0] as { maxPages: number; mode: string; sameOriginOnly: boolean; enabled: boolean });
    expect(calls.map((c) => c.maxPages)).toEqual([10, 500, 1]);
    expect(calls[0]!.mode).toBe('browser');
    expect(calls[0]!.sameOriginOnly).toBe(true);
    expect(calls[0]!.enabled).toBe(true);
  });

  it('POST /crawl-targets relays a registry refusal as a 400, not a 500', async () => {
    m(addCrawlTarget).mockImplementation(() => { throw new Error('duplicate label'); });
    const res = await request(buildApp()).post('/api/ingest/crawl-targets')
      .send({ startUrl: 'https://a.example.com', label: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('duplicate label');
  });

  it('PATCH /crawl-targets/:id validates only the fields present', async () => {
    m(updateCrawlTarget).mockReturnValue({ id: 'ct-1', label: 'renamed' });
    const app = buildApp();
    const partial = await request(app).patch('/api/ingest/crawl-targets/ct-1').send({ label: 'renamed' });
    expect(partial.status).toBe(200);
    expect(partial.body.target.label).toBe('renamed');

    const badUrl = await request(app).patch('/api/ingest/crawl-targets/ct-1').send({ startUrl: 'nope' });
    expect(badUrl.status).toBe(400);
  });

  it('PATCH /crawl-targets/:id 404s an unknown target', async () => {
    m(updateCrawlTarget).mockReturnValue(null);
    const res = await request(buildApp()).patch('/api/ingest/crawl-targets/ct-x').send({ label: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /crawl-targets/:id 404s an unknown target and 200s a removal', async () => {
    m(removeCrawlTarget).mockReturnValue(false);
    expect((await request(buildApp()).delete('/api/ingest/crawl-targets/ct-x')).status).toBe(404);
    m(removeCrawlTarget).mockReturnValue(true);
    const ok = await request(buildApp()).delete('/api/ingest/crawl-targets/ct-1');
    expect(ok.body).toEqual({ ok: true });
  });

  it('POST /crawl-targets/:id/run starts the target\'s OWN config and records the run', async () => {
    m(getCrawlTarget).mockReturnValue({
      id: 'ct-1', label: 'docs', startUrl: 'https://docs.example.com',
      maxPages: 40, mode: 'browser_spa', includePattern: '^(/docs)(/|$)', sameOriginOnly: true,
    });
    m(startCrawl).mockResolvedValue(crawlSession({ id: 'cr-7' }));
    const res = await request(buildApp()).post('/api/ingest/crawl-targets/ct-1/run').send({});
    expect(res.status).toBe(202);
    expect(res.body.crawlId).toBe('cr-7');
    // The stored config wins — a run must not silently widen the target.
    expect(m(startCrawl).mock.calls[0]![0]).toMatchObject({
      startUrl: 'https://docs.example.com', maxPages: 40, mode: 'browser_spa',
      includePattern: '^(/docs)(/|$)', targetId: 'ct-1',
    });
    expect(recordTargetRun).toHaveBeenCalledWith('ct-1', 'cr-7', 'running');
  });

  it('POST /crawl-targets/:id/run 404s an unknown target', async () => {
    m(getCrawlTarget).mockReturnValue(undefined);
    expect((await request(buildApp()).post('/api/ingest/crawl-targets/ct-x/run').send({})).status).toBe(404);
    expect(startCrawl).not.toHaveBeenCalled();
  });
});

// ── Site survey ────────────────────────────────────────────────────────────

describe('site survey', () => {
  const SURVEY = {
    id: 'sv-1', startUrl: 'https://docs.example.com/', origin: 'https://docs.example.com',
    pages: [
      { path: '/docs', status: 'ok' },
      { path: '/docs/setup', status: 'ok' },
      { path: '/docs-internal/x', status: 'ok' },
      { path: '/blog', status: 'ok' },
      { path: '/docs/broken', status: 'error' },
    ],
  };

  it('POST /survey 400s a missing startUrl and 202s a started survey', async () => {
    const app = buildApp();
    const missing = await request(app).post('/api/ingest/survey').send({ startUrl: '   ' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/startUrl is required/);

    m(startSurvey).mockResolvedValue(SURVEY);
    const ok = await request(app).post('/api/ingest/survey')
      .send({ startUrl: ' https://docs.example.com ', maxPages: 30 });
    expect(ok.status).toBe(202);
    expect(ok.body.id).toBe('sv-1');
    expect(startSurvey).toHaveBeenCalledWith({
      startUrl: 'https://docs.example.com', maxPages: 30,
    });
  });

  it('GET /surveys wraps the list; GET /survey/:id 404s an unknown one', async () => {
    m(listSurveys).mockReturnValue([SURVEY]);
    const list = await request(buildApp()).get('/api/ingest/surveys');
    expect(Object.keys(list.body)).toEqual(['surveys']);

    m(getSurvey).mockReturnValue(SURVEY);
    const one = await request(buildApp()).get('/api/ingest/survey/sv-1');
    expect(one.status).toBe(200);
    expect(one.body.pages).toHaveLength(5);

    m(getSurvey).mockReturnValue(undefined);
    expect((await request(buildApp()).get('/api/ingest/survey/sv-x')).status).toBe(404);
  });

  it('POST /survey/:id/target builds a PATHNAME-anchored, escaped include pattern', async () => {
    // The crawler matches includeRegex against `new URL(target).pathname`, so
    // an origin-anchored pattern excluded every page and the crawl visited its
    // start URL and stopped. `(/|$)` also keeps /docs from matching
    // /docs-internal.
    m(getSurvey).mockReturnValue(SURVEY);
    m(addCrawlTarget).mockReturnValue({ id: 'ct-9' });
    const res = await request(buildApp()).post('/api/ingest/survey/sv-1/target')
      .send({ prefixes: ['/docs'] });
    expect(res.status).toBe(201);
    expect(res.body.includePattern).toBe('^(/docs)(/|$)');
    const re = new RegExp(res.body.includePattern as string);
    expect(re.test('/docs')).toBe(true);
    expect(re.test('/docs/setup')).toBe(true);
    expect(re.test('/docs-internal/x')).toBe(false);
    expect(re.test('/blog')).toBe(false);
    expect(re.test('https://docs.example.com/docs')).toBe(false);
  });

  it('escapes regex metacharacters in a selected prefix', async () => {
    m(getSurvey).mockReturnValue(SURVEY);
    m(addCrawlTarget).mockReturnValue({ id: 'ct-10' });
    const res = await request(buildApp()).post('/api/ingest/survey/sv-1/target')
      .send({ prefixes: ['/a.b+c'] });
    expect(res.body.includePattern).toBe('^(/a\\.b\\+c)(/|$)');
    expect(new RegExp(res.body.includePattern as string).test('/axbxc')).toBe(false);
  });

  it('defaults maxPages to the pages actually IN SCOPE, counting only ok ones', async () => {
    m(getSurvey).mockReturnValue(SURVEY);
    m(addCrawlTarget).mockReturnValue({ id: 'ct-11' });
    const res = await request(buildApp()).post('/api/ingest/survey/sv-1/target')
      .send({ prefixes: ['/docs'] });
    // /docs and /docs/setup are ok; /docs/broken is not; /docs-internal is out.
    expect(res.body.pagesInScope).toBe(2);
    expect((m(addCrawlTarget).mock.calls[0]![0] as { maxPages: number }).maxPages).toBe(2);
  });

  it('refuses an empty or non-path selection', async () => {
    m(getSurvey).mockReturnValue(SURVEY);
    const app = buildApp();
    for (const prefixes of [[], ['docs'], 'nope']) {
      const res = await request(app).post('/api/ingest/survey/sv-1/target').send({ prefixes });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one section/);
    }
    expect(addCrawlTarget).not.toHaveBeenCalled();
  });

  it('POST /survey/:id/target 404s an unknown survey', async () => {
    m(getSurvey).mockReturnValue(undefined);
    const res = await request(buildApp()).post('/api/ingest/survey/sv-x/target')
      .send({ prefixes: ['/docs'] });
    expect(res.status).toBe(404);
  });
});
