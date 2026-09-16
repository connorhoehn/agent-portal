// GET /api/work/jobs and GET /api/work/jobs/:id — `result.toolCallList` on
// the wire (routes/work.ts::withToolCallList, providers/agent-jobs.ts).
//
// Deliberately NOT mocking providers/agent-jobs.js, same reasoning as
// work-sme-journey.test.ts: the interesting behaviour is in the real
// `config.mock.aurora` queue driving a job through its actual lifecycle, not
// in a stub that already knows the answer.
//
// What is pinned:
//   * a job whose completed result carries a real transcript reports the
//     tool calls it actually made, on both the list and detail routes,
//   * a job with no transcript but a toolCalls count falls back to the
//     deterministic mock cycle,
//   * a job with neither carries no toolCallList at all — not an empty one.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } },
}));

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';
import { enqueueJob, claimJob, markRunning, completeJob, _resetMockQueue } from '../../providers/agent-jobs.js';

interface WireJob {
  id: string;
  result: { toolCallList?: { name: string; done: boolean }[] } | null;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };
    next();
  });
  app.use('/api/work', workRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { _resetMockQueue(); });

async function runToAwaitingReview(title: string, result: Record<string, unknown>): Promise<string> {
  const job = await enqueueJob({ kind: 'devbox:task', title });
  await claimJob(job!.id, 'box-a', 'sess-a');
  await markRunning(job!.id);
  await completeJob(job!.id, { status: 'awaiting_review', result });
  return job!.id;
}

describe('toolCallList on the wire', () => {
  it('reads a real transcript on both the list and the detail route', async () => {
    const id = await runToAwaitingReview('Bump a dependency', {
      summary: 'Bumped it.', costUsd: 0.02, toolCalls: 2,
      transcript: [
        { t: 'tool', name: 'Bash', detail: 'npm audit --json', ts: '2026-03-01T00:00:00.000Z' },
        { t: 'text', detail: 'Reachable from the report renderer only.', ts: '2026-03-01T00:00:01.000Z' },
        { t: 'tool', name: 'Edit', detail: 'package.json', ts: '2026-03-01T00:00:02.000Z' },
      ],
    });
    const app = buildApp();

    const listed = ((await request(app).get('/api/work/jobs?status=awaiting_review&limit=200')).body.jobs as WireJob[])
      .find((j) => j.id === id);
    expect(listed?.result?.toolCallList).toEqual([
      { name: 'Bash', done: true }, { name: 'Edit', done: true },
    ]);

    const detail = (await request(app).get(`/api/work/jobs/${id}`)).body as WireJob;
    expect(detail.result?.toolCallList).toEqual(listed?.result?.toolCallList);
  });

  it('falls back to the deterministic kind-keyed cycle when the transcript is empty', async () => {
    const id = await runToAwaitingReview('Triage flaky tests', {
      summary: 'Both flakes are clock-boundary.', costUsd: 0.03, toolCalls: 3, transcript: [],
    });
    const res = await request(buildApp()).get(`/api/work/jobs/${id}`);
    expect((res.body as WireJob).result?.toolCallList).toEqual([
      { name: 'read_file', done: true },
      { name: 'edit_file', done: true },
      { name: 'run_tests', done: true },
    ]);
  });

  it('carries no toolCallList for a job with no toolCalls signal', async () => {
    const id = await runToAwaitingReview('Just a note', { summary: 'Nothing to report.' });
    const res = await request(buildApp()).get(`/api/work/jobs/${id}`);
    expect((res.body as WireJob).result?.toolCallList).toBeUndefined();
  });
});
