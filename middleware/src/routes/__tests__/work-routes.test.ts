// Work — /api/work (routes/work.ts): the agentic loop's front door. Queue,
// findings, graph proposals and the overview header.
//
// (The grant-scoped `POST /findings/:id/promote` and the SME journey have
// their own suites; this covers the sixteen routes they do not reach.)
//
// What is pinned:
//   * the AUTH-FLOOR SHAPE the router argues for at length. Two gates here
//     were audited and deliberately moved, and both moves are invisible
//     without a test: `POST /sweeps/run` is a read-tier SESSION floor (it
//     reads the graph and rewrites a cache — no Bedrock call, no job), and
//     promoting a finding is `DispatchAgentRun`, not `ManageDevbox`, because
//     it enqueues agent work. `ManageDevbox` 403'd program-owner on a spend
//     the same role could already authorise elsewhere,
//   * the summary's counts are DERIVED from a real GROUP BY, not a capped
//     page — `findings.open`/`critical`/`warning` sum `findingStats()`'s
//     grouped rows (the same query `/findings/stats` uses), never
//     `listFindings({ limit: 300 }).length`, which silently undercounts the
//     moment a program crosses 300 open findings. `consults.pending` counts
//     the pending consults fetched (that list has no cap to hide behind). A
//     hand-written total next to a list it claims to count is the fixture bug
//     class this repo has shipped before,
//   * the attribution contract on `POST /jobs`: `suggestionId` is decoded
//     SERVER-side (`sg-<workItemId>`) so the id shape stays ours, the item is
//     looked up before it is stored so a caller cannot assert a link to
//     something that does not exist, and the initiative comes from the BOARD
//     rather than from the request,
//   * that a stale attribution is dropped rather than fatal — refusing to
//     dispatch real work over a bad chip would be the wrong trade,
//   * the queue's refusal branches: 503 when Aurora is unreachable, 409 for a
//     requeue of a live job and for cancelling one, 404 for an unknown job,
//   * that rejecting a review and cancelling a job REOPEN the finding, so
//     work does not stay pinned to output a human refused.

const gateActions: string[] = [];
const sessionLabels: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireSession: (label: string) => {
    sessionLabels.push(label);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/sweep-runs.js', () => ({ listSweepRuns: jest.fn() }));
// The background mode's job table reads config; its own tests are lib/__tests__/sweep-jobs.test.ts and work-sweep-jobs.test.ts.
jest.mock('../../lib/sweep-jobs.js', () => ({ startSweepJob: jest.fn(), getSweepJob: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ searchWorkItems: jest.fn(), getWorkItem: jest.fn() }));
const scopeDeny = new Set<string>();
const scopeCalls: Array<{ initiativeId: unknown; opts: unknown }> = [];
jest.mock('../../lib/initiative-scope.js', () => ({
  stewardsInitiative: jest.fn(),
  requireInitiativeScope: jest.fn(async (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, initiativeId: string | null, opts: unknown) => {
    scopeCalls.push({ initiativeId, opts });
    if (initiativeId && scopeDeny.has(initiativeId)) { res.status(403).json({ error: 'not your initiative' }); return false; }
    return true;
  }),
}));
jest.mock('../../lib/work-suggestions.js', () => ({
  rankSuggestions: jest.fn(), askSuggestionsFrom: jest.fn(), seesEveryInitiative: jest.fn(),
}));
jest.mock('../../lib/sse.js', () => ({
  initSSE: (res: { writeHead: (n: number, h: Record<string, string>) => void }) =>
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }),
  writeSSE: (res: { writableEnded: boolean; write: (s: string) => void }, data: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  },
  endSSE: (res: { writableEnded: boolean; end: () => void }) => { if (!res.writableEnded) res.end(); },
}));
jest.mock('../../providers/agent-jobs.js', () => ({
  enqueueJob: jest.fn(), listJobs: jest.fn(), getJob: jest.fn(), reviewJob: jest.fn(),
  cancelJob: jest.fn(), queueStats: jest.fn(), requeueJob: jest.fn(),
  // Identity here — real derivation is covered against the real queue in
  // work-jobs-tool-call-list.test.ts. This suite only needs the route to call
  // it on every job it reads, which the assertions below check directly.
  withToolCallList: jest.fn((j: unknown) => j),
}));
jest.mock('../../providers/org-sweeps.js', () => ({
  runSweep: jest.fn(), runAllSweeps: jest.fn(), listFindings: jest.fn(),
  setFindingStatus: jest.fn(), getFinding: jest.fn(), findingStats: jest.fn(),
  remediationFor: jest.fn(), reopenFindingForJob: jest.fn(),
  releaseAbandonedFindings: jest.fn(), initiativeIdForFinding: jest.fn(),
  SWEEP_NAMES: ['bus_factor', 'stale_docs', 'orphan_decisions'],
}));
jest.mock('../../lib/bot-runner.js', () => ({ grantScopedDispatchVerdict: jest.fn() }));
jest.mock('../../providers/graph-proposals.js', () => ({
  listProposals: jest.fn(), decideProposal: jest.fn(),
  proposeGraphChange: jest.fn(), proposalStats: jest.fn(),
}));
jest.mock('../../lib/job-dispatcher.js', () => {
  const { EventEmitter } = jest.requireActual<typeof import('node:events')>('node:events');
  return { dispatcherEvents: new EventEmitter(), dispatchOnce: jest.fn(), busyBoxes: jest.fn() };
});
jest.mock('../../providers/doc-linker.js', () => ({
  analyzeDocumentLinks: jest.fn(), analyzeDocumentFindings: jest.fn(),
}));
jest.mock('../../providers/lab.js', () => ({ listConsults: jest.fn() }));
jest.mock('../../providers/local-compute.js', () => ({ getNode: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { workRouter } from '../work.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser } from '../../providers/identity.js';
import { searchWorkItems, getWorkItem } from '../../providers/work-items.js';
import { rankSuggestions, askSuggestionsFrom, seesEveryInitiative } from '../../lib/work-suggestions.js';
import { stewardsInitiative } from '../../lib/initiative-scope.js';
import {
  enqueueJob, listJobs, getJob, reviewJob, cancelJob, queueStats, requeueJob, withToolCallList,
} from '../../providers/agent-jobs.js';
import {
  runSweep, runAllSweeps, listFindings, setFindingStatus, getFinding, findingStats,
  reopenFindingForJob, releaseAbandonedFindings, initiativeIdForFinding,
} from '../../providers/org-sweeps.js';
import { listProposals, decideProposal, proposeGraphChange, proposalStats } from '../../providers/graph-proposals.js';
import { dispatcherEvents, dispatchOnce, busyBoxes } from '../../lib/job-dispatcher.js';
import { analyzeDocumentLinks, analyzeDocumentFindings } from '../../providers/doc-linker.js';
import { listConsults } from '../../providers/lab.js';
import { getNode } from '../../providers/local-compute.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const SESSION = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };

function buildApp(session: Record<string, unknown> | null = SESSION) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/work', workRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(busyBoxes).mockReturnValue([]);
  m(seesEveryInitiative).mockReturnValue(true);
});

// ── Auth floor ─────────────────────────────────────────────────────────────

describe('the gate matrix', () => {
  it('puts sweeps/run on a SESSION floor, not on a capability', () => {
    // Running sweeps reads the graph and rewrites the findings cache — no
    // Bedrock call, no job, nothing spent. It belongs on the read tier.
    expect(sessionLabels).toContain('RunSweeps');
    expect(gateActions).not.toContain('RunSweeps');
  });

  it('gates finding promotion on DispatchAgentRun — it enqueues agent work', () => {
    // ManageDevbox is the Computer Lab capability; gating dispatch on it 403'd
    // program-owner on spend the same role could authorise elsewhere.
    expect(gateActions.filter((a) => a === 'DispatchAgentRun')).toHaveLength(1);
  });

  it('keeps both suggestion reads on the session floor', () => {
    expect(sessionLabels.filter((l) => l === 'WorkSuggestions')).toHaveLength(2);
  });
});

// ── Summary ────────────────────────────────────────────────────────────────

describe('GET /api/work/summary', () => {
  it('derives every count from the GROUP BY, not a capped list', async () => {
    m(queueStats).mockResolvedValue({ queued: 2, running: 1, failed: 0 });
    m(proposalStats).mockResolvedValue({ pending: 3, approved: 9 });
    m(findingStats).mockResolvedValue([
      { sweep: 'bus_factor', status: 'open', severity: 'critical', n: 1 },
      { sweep: 'stale_docs', status: 'open', severity: 'warning', n: 2 },
      { sweep: 'stale_docs', status: 'open', severity: 'info', n: 1 },
      // Not open — must NOT be counted into `open`.
      { sweep: 'orphan_decisions', status: 'dismissed', severity: 'critical', n: 5 },
    ]);
    m(listConsults).mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    m(busyBoxes).mockReturnValue(['box-1']);

    const res = await request(buildApp()).get('/api/work/summary');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort())
      .toEqual(['busyBoxes', 'consults', 'findings', 'jobs', 'proposals', 'sweeps']);
    expect(res.body.findings).toEqual({ open: 4, critical: 1, warning: 2 });
    expect(res.body.consults).toEqual({ pending: 2 });
    expect(res.body.busyBoxes).toEqual(['box-1']);
    // The sweep vocabulary travels with the summary so the page's filter can
    // be built from the server's list rather than a copy.
    expect(res.body.sweeps).toEqual(['bus_factor', 'stale_docs', 'orphan_decisions']);
  });

  // The whole point of the fix: `findingStats()` is never capped the way
  // `listFindings({ limit: 300 })` is, so the summary must report the REAL
  // open count even when it is well past what a 300-row page could ever
  // carry. Fails against the old implementation, which read
  // `listFindings({ limit: 300 }).length` and could never exceed 300.
  it('reports an open count past what any capped page could carry', async () => {
    m(queueStats).mockResolvedValue({});
    m(proposalStats).mockResolvedValue({});
    m(findingStats).mockResolvedValue([
      { sweep: 'bus_factor', status: 'open', severity: 'warning', n: 450 },
    ]);
    m(listConsults).mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/work/summary');
    expect(res.body.findings.open).toBe(450);
    expect(res.body.findings.warning).toBe(450);
  });

  it('reports honest zeroes on an empty program', async () => {
    m(queueStats).mockResolvedValue({});
    m(proposalStats).mockResolvedValue({});
    m(findingStats).mockResolvedValue([]);
    m(listConsults).mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/work/summary');
    expect(res.body.findings).toEqual({ open: 0, critical: 0, warning: 0 });
    expect(res.body.consults.pending).toBe(0);
  });
});

// ── Suggestions ────────────────────────────────────────────────────────────

describe('GET /api/work/ask-suggestions', () => {
  it('re-voices the SAME ranked work as questions', async () => {
    m(getUser).mockResolvedValue({ personId: 'p-004' });
    m(searchWorkItems).mockResolvedValue([
      { id: 'wi-1', projectId: 'p-obs', projectName: 'Observability', type: 'bug', title: 'flaky', status: 'open', priority: 1, assigneeId: null, storyPoints: 3 },
    ]);
    m(rankSuggestions).mockReturnValue([{ id: 'sg-wi-1', title: 'flaky' }]);
    m(askSuggestionsFrom).mockReturnValue([{ id: 'sg-wi-1', question: 'who can unblock flaky?' }]);

    const res = await request(buildApp()).get('/api/work/ask-suggestions');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['suggestions']);
    expect(res.body.suggestions[0].question).toBe('who can unblock flaky?');
    // The question cards are derived from the ranked cards, not a second rank.
    expect(m(askSuggestionsFrom).mock.calls[0]![0]).toEqual([{ id: 'sg-wi-1', title: 'flaky' }]);
  });

  it('narrows an SME to the initiatives they steward before ranking', async () => {
    m(seesEveryInitiative).mockReturnValue(false);
    m(getUser).mockResolvedValue({ personId: 'p-004' });
    m(searchWorkItems).mockResolvedValue([
      { id: 'wi-1', projectId: 'p-mine', projectName: 'Mine', type: 'bug', title: 'a', status: 'open', priority: 1, assigneeId: null, storyPoints: 1 },
      { id: 'wi-2', projectId: 'p-theirs', projectName: 'Theirs', type: 'bug', title: 'b', status: 'open', priority: 1, assigneeId: null, storyPoints: 1 },
    ]);
    m(stewardsInitiative).mockImplementation(async (_s: unknown, id: string) => id === 'p-mine');
    m(rankSuggestions).mockReturnValue([]);
    m(askSuggestionsFrom).mockReturnValue([]);

    await request(buildApp()).get('/api/work/ask-suggestions');
    const ranked = m(rankSuggestions).mock.calls[0]![0] as Array<{ id: string }>;
    expect(ranked.map((r) => r.id)).toEqual(['wi-1']);
    expect(m(rankSuggestions).mock.calls[0]![1]).toEqual({ personId: 'p-004' });
  });

  it('ranks with a null person when the account is not linked to one', async () => {
    m(getUser).mockResolvedValue({ personId: null });
    m(searchWorkItems).mockResolvedValue([]);
    m(rankSuggestions).mockReturnValue([]);
    m(askSuggestionsFrom).mockReturnValue([]);
    await request(buildApp()).get('/api/work/ask-suggestions');
    expect(m(rankSuggestions).mock.calls[0]![1]).toEqual({ personId: null });
  });
});

// ── Jobs ───────────────────────────────────────────────────────────────────

// docs/next-steps.md section 8, package 6: a `local:*` job runs on a person's
// own laptop, so it must name a machine the caller owns. An untargeted one was
// claimable by every paired worker, so any ManageDevbox holder could run a
// prompt on someone else's machine.
describe('POST /api/work/jobs — local kinds bind to an owned node', () => {
  const NODE = { id: 'node-nora', ownerId: 'u-nora', revokedAt: null };

  it('400s a local:* job with no nodeId, and queues nothing', async () => {
    const res = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', kind: 'local:task' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nodeId/);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('403s a local:* job naming someone else\'s node, or one that does not exist', async () => {
    m(getNode).mockResolvedValueOnce({ ...NODE, id: 'node-raj', ownerId: 'u-raj' });
    const theirs = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', kind: 'local:task', nodeId: 'node-raj' });
    expect(theirs.status).toBe(403);
    m(getNode).mockResolvedValueOnce(null);
    const ghost = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', kind: 'local:task', nodeId: 'node-ghost' });
    expect(ghost.status).toBe(403);
    m(getNode).mockResolvedValueOnce({ ...NODE, revokedAt: '2026-11-01T00:00:00.000Z' });
    const revoked = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', kind: 'local:task', nodeId: 'node-nora' });
    expect(revoked.status).toBe(403);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('queues a local:* job targeted at the caller\'s own node', async () => {
    m(getNode).mockResolvedValueOnce(NODE);
    m(enqueueJob).mockResolvedValue({ id: 'job-1', status: 'queued', payload: {} });
    const res = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', kind: 'local:task', nodeId: 'node-nora' });
    expect(res.status).toBe(201);
    expect((m(enqueueJob).mock.calls[0]![0] as { payload: Record<string, unknown> }).payload)
      .toMatchObject({ nodeId: 'node-nora' });
  });

  it('ignores nodeId on a devbox:task (the cloud fleet is not targeted)', async () => {
    m(enqueueJob).mockResolvedValue({ id: 'job-1', status: 'queued', payload: {} });
    const res = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', nodeId: 'node-raj' });
    expect(res.status).toBe(201);
    expect(getNode).not.toHaveBeenCalled();
    expect((m(enqueueJob).mock.calls[0]![0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty('nodeId');
  });
});

describe('POST /api/work/jobs — attribution', () => {
  const JOB = { id: 'job-1', status: 'queued', payload: {} };

  it('400s without a title or a prompt, naming what a prompt is for', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/work/jobs').send({ prompt: 'p' })).status).toBe(400);
    const noPrompt = await request(app).post('/api/work/jobs').send({ title: 't' });
    expect(noPrompt.status).toBe(400);
    expect(noPrompt.body.error).toMatch(/it is what the worker runs/);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('decodes sg-<workItemId> SERVER-side and takes the initiative from the BOARD', async () => {
    m(getWorkItem).mockResolvedValue({
      id: 'wi-1', title: 'Fix the flake', projectId: 'p-obs', projectName: 'Observability Platform',
    });
    m(enqueueJob).mockResolvedValue(JOB);
    const res = await request(buildApp()).post('/api/work/jobs').send({
      title: 't', prompt: 'p', suggestionId: 'sg-wi-1',
      // A client claim about the initiative must not win.
      initiativeId: 'p-something-else',
    });
    expect(res.status).toBe(201);
    expect(getWorkItem).toHaveBeenCalledWith('wi-1');
    expect((m(enqueueJob).mock.calls[0]![0] as { payload: Record<string, unknown> }).payload)
      .toMatchObject({
        workItemId: 'wi-1', workItemTitle: 'Fix the flake',
        initiativeId: 'p-obs', initiativeName: 'Observability Platform',
      });
  });

  it('drops a stale attribution rather than refusing to run the work', async () => {
    m(getWorkItem).mockResolvedValue(null);
    m(enqueueJob).mockResolvedValue(JOB);
    const res = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', workItemId: 'wi-gone' });
    expect(res.status).toBe(201);
    const payload = (m(enqueueJob).mock.calls[0]![0] as { payload: Record<string, unknown> }).payload;
    expect(payload['workItemId']).toBeUndefined();
    expect(payload['prompt']).toBe('p');
  });

  it('survives a board lookup that throws', async () => {
    m(getWorkItem).mockRejectedValue(new Error('Data API cold start'));
    m(enqueueJob).mockResolvedValue(JOB);
    const res = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', workItemId: 'wi-1' });
    expect(res.status).toBe(201);
  });

  it('defaults requiresReview to true and only an explicit false turns it off', async () => {
    m(enqueueJob).mockResolvedValue(JOB);
    const app = buildApp();
    await request(app).post('/api/work/jobs').send({ title: 't', prompt: 'p' });
    await request(app).post('/api/work/jobs').send({ title: 't', prompt: 'p', requiresReview: false });
    const reviews = m(enqueueJob).mock.calls
      .map((c) => (c[0] as { payload: Record<string, unknown> }).payload['requiresReview']);
    expect(reviews).toEqual([true, false]);
  });

  it('attributes the job to the session, and marks a promoted finding', async () => {
    m(enqueueJob).mockResolvedValue(JOB);
    m(getFinding).mockResolvedValue({ id: 'find-1', status: 'open', jobId: null });
    await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', findingId: 'find-1' });
    expect((m(enqueueJob).mock.calls[0]![0] as { createdBy: string }).createdBy).toBe('u-nora');
    expect(setFindingStatus).toHaveBeenCalledWith('find-1', 'promoted', 'job-1');
  });

  it('503s — not 500 — when the queue is unreachable', async () => {
    m(enqueueJob).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/queue unavailable/);
  });
});

describe('POST /api/work/jobs — initiative scope (DE-44 row 6)', () => {
  const JOB = { id: 'job-1', status: 'queued', payload: {} };
  beforeEach(() => { scopeDeny.clear(); scopeCalls.length = 0; m(enqueueJob).mockResolvedValue(JOB); });

  it('refuses to queue work on an initiative the caller may not spend on, and queues nothing', async () => {
    m(getWorkItem).mockResolvedValue({ id: 'wi-1', title: 'Fix it', projectId: 'p-billing', projectName: 'Billing' });
    scopeDeny.add('p-billing');
    const res = await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p', workItemId: 'wi-1' });
    expect(res.status).toBe(403);
    expect(scopeCalls[0]).toEqual({ initiativeId: 'p-billing', opts: expect.objectContaining({ spend: true }) });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('a findingId asks the promote route\'s question, and an unknown or taken finding is refused', async () => {
    m(getFinding).mockResolvedValue({ id: 'f-1', status: 'open', jobId: null });
    m(initiativeIdForFinding).mockReturnValue('p-billing');
    scopeDeny.add('p-billing');
    expect((await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p', findingId: 'f-1' })).status).toBe(403);
    m(getFinding).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p', findingId: 'f-x' })).status).toBe(404);
    m(getFinding).mockResolvedValue({ id: 'f-2', status: 'promoted', jobId: 'job-9' });
    expect((await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p', findingId: 'f-2' })).status).toBe(409);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(setFindingStatus).not.toHaveBeenCalled();
  });
});

describe('GET /jobs and GET /jobs/:id project the wire through withToolCallList', () => {
  it('maps every listed job through withToolCallList', async () => {
    const jobs = [{ id: 'job-1', status: 'awaiting_review' }, { id: 'job-2', status: 'queued' }];
    m(listJobs).mockResolvedValue(jobs);
    const res = await request(buildApp()).get('/api/work/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual(jobs);
    expect(withToolCallList).toHaveBeenCalledTimes(2);
    expect(withToolCallList).toHaveBeenNthCalledWith(1, jobs[0]);
    expect(withToolCallList).toHaveBeenNthCalledWith(2, jobs[1]);
  });

  it('projects a single job the same way, and 404s an unknown one without touching the projection', async () => {
    const job = { id: 'job-1', status: 'awaiting_review' };
    m(getJob).mockResolvedValue(job);
    const res = await request(buildApp()).get('/api/work/jobs/job-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(job);
    expect(withToolCallList).toHaveBeenCalledWith(job);

    m(getJob).mockResolvedValue(null);
    m(withToolCallList).mockClear();
    const missing = await request(buildApp()).get('/api/work/jobs/job-x');
    expect(missing.status).toBe(404);
    expect(withToolCallList).not.toHaveBeenCalled();
  });
});

describe('job lifecycle verbs', () => {
  it('POST /jobs/:id/review refuses anything but accept/reject', async () => {
    const app = buildApp();
    for (const decision of [undefined, 'maybe', 'ACCEPT']) {
      const res = await request(app).post('/api/work/jobs/job-1/review').send({ decision });
      expect(res.status).toBe(400);
    }
    expect(reviewJob).not.toHaveBeenCalled();
  });

  it('POST /jobs/:id/review REOPENS the finding on a reject, not on an accept', async () => {
    m(reviewJob).mockResolvedValue({ id: 'job-1', status: 'rejected' });
    await request(buildApp()).post('/api/work/jobs/job-1/review')
      .send({ decision: 'reject', note: 'did not fix it' });
    expect(reviewJob).toHaveBeenCalledWith('job-1', 'reject', 'did not fix it');
    expect(reopenFindingForJob).toHaveBeenCalledWith('job-1');

    jest.clearAllMocks();
    m(reviewJob).mockResolvedValue({ id: 'job-1', status: 'accepted' });
    await request(buildApp()).post('/api/work/jobs/job-1/review').send({ decision: 'accept' });
    expect(reopenFindingForJob).not.toHaveBeenCalled();
  });

  it('POST /jobs/:id/review 404s a job that is not awaiting review', async () => {
    m(reviewJob).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/work/jobs/job-x/review').send({ decision: 'accept' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not awaiting review/);
  });

  it('POST /jobs/:id/requeue clones the dead job and answers 201', async () => {
    m(requeueJob).mockResolvedValue({ id: 'job-2', status: 'queued' });
    const res = await request(buildApp()).post('/api/work/jobs/job-1/requeue').send({});
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('job-2');
    // Attributed to the requester, not to the original author.
    expect(requeueJob).toHaveBeenCalledWith('job-1', 'u-nora');
    // One read, for the job's initiative (DE-44 row 7) — not the 404/409 fallback.
    expect(getJob).toHaveBeenCalledTimes(1);
  });

  it('POST /jobs/:id/requeue distinguishes 404 (no such job) from 409 (still alive)', async () => {
    m(requeueJob).mockResolvedValue(null);
    m(getJob).mockResolvedValue(null);
    const missing = await request(buildApp()).post('/api/work/jobs/job-x/requeue').send({});
    expect(missing.status).toBe(404);

    m(getJob).mockResolvedValue({ id: 'job-1', status: 'running' });
    const alive = await request(buildApp()).post('/api/work/jobs/job-1/requeue').send({});
    expect(alive.status).toBe(409);
    expect(alive.body.error).toMatch(/this one is running/);
  });

  it('DELETE /jobs/:id cancels, reopens what it was pinned to, and 409s a live job', async () => {
    m(cancelJob).mockResolvedValue(true);
    m(reopenFindingForJob).mockResolvedValue(2);
    const ok = await request(buildApp()).delete('/api/work/jobs/job-1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ cancelled: true, reopenedFindings: 2 });

    jest.clearAllMocks();
    m(cancelJob).mockResolvedValue(false);
    const live = await request(buildApp()).delete('/api/work/jobs/job-1');
    expect(live.status).toBe(409);
    expect(live.body.error).toMatch(/not cancellable/);
    // Nothing was cancelled, so nothing is put back on the board.
    expect(reopenFindingForJob).not.toHaveBeenCalled();
  });

  it('POST /dispatch kicks a pass and answers with the FRESH queue stats', async () => {
    m(queueStats).mockResolvedValue({ queued: 0, running: 1 });
    const res = await request(buildApp()).post('/api/work/dispatch').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, stats: { queued: 0, running: 1 } });
    expect(dispatchOnce).toHaveBeenCalled();
    // Stats are read AFTER the pass, or the caller sees the pre-dispatch queue.
    expect(m(dispatchOnce).mock.invocationCallOrder[0]!)
      .toBeLessThan(m(queueStats).mock.invocationCallOrder[0]!);
  });
});

describe('GET /api/work/events', () => {
  const settle = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

  it('subscribes to the dispatcher while open and UNSUBSCRIBES on close', async () => {
    // The leak this guards: one listener per page load, never removed, so a
    // long-lived middleware accumulates writers to dead sockets.
    const bus = dispatcherEvents as unknown as import('node:events').EventEmitter;
    const before = bus.listenerCount('job');
    const pending = request(buildApp()).get('/api/work/events');
    pending.then(() => undefined, () => undefined);
    await settle(60);
    expect(bus.listenerCount('job')).toBe(before + 1);
    // A live event reaches the open stream without throwing.
    bus.emit('job', { type: 'claimed', jobId: 'job-1' });
    pending.abort();
    await settle(60);
    expect(bus.listenerCount('job')).toBe(before);
  });
});

// ── Findings ───────────────────────────────────────────────────────────────

describe('findings', () => {
  it('GET /findings defaults to open and forwards a sweep filter only when given', async () => {
    m(listFindings).mockResolvedValue([{ id: 'f1', severity: 'critical' }]);
    const app = buildApp();
    const res = await request(app).get('/api/work/findings');
    expect(Object.keys(res.body)).toEqual(['findings']);
    expect(m(listFindings).mock.calls[0]![0]).toEqual({ status: 'open', limit: 100 });

    await request(app).get('/api/work/findings?status=dismissed&sweep=stale_docs&limit=5');
    expect(m(listFindings).mock.calls[1]![0]).toEqual({ status: 'dismissed', sweep: 'stale_docs', limit: 5 });
  });

  it('GET /findings/stats wraps the grouped counts', async () => {
    m(findingStats).mockResolvedValue({ bus_factor: { open: 3, critical: 1 } });
    const res = await request(buildApp()).get('/api/work/findings/stats');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['stats']);
    expect(res.body.stats.bus_factor.open).toBe(3);
  });

  it('POST /sweeps/run rejects an unknown sweep, NAMING the ones it knows', async () => {
    const res = await request(buildApp()).post('/api/work/sweeps/run').send({ sweep: 'vibes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown sweep 'vibes'/);
    expect(res.body.error).toMatch(/bus_factor, stale_docs, orphan_decisions/);
    expect(runSweep).not.toHaveBeenCalled();
    expect(runAllSweeps).not.toHaveBeenCalled();
  });

  it('POST /sweeps/run gives a single sweep the SAME self-heal pass as run-all', async () => {
    m(releaseAbandonedFindings).mockResolvedValue(2);
    m(runSweep).mockResolvedValue({ sweep: 'stale_docs', found: 4 });
    const res = await request(buildApp()).post('/api/work/sweeps/run').send({ sweep: 'stale_docs' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ sweep: 'stale_docs', found: 4 }], released: 2 });
    expect(runAllSweeps).not.toHaveBeenCalled();
  });

  it('POST /sweeps/run with no sweep runs them all', async () => {
    m(runAllSweeps).mockResolvedValue({ results: [], released: 0 });
    const res = await request(buildApp()).post('/api/work/sweeps/run').send({});
    expect(res.status).toBe(200);
    expect(runAllSweeps).toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it('POST /findings/analyze-batch defaults to 10 stale_docs and returns `remaining`', async () => {
    m(analyzeDocumentFindings).mockResolvedValue({ analysed: 4, proposed: 9, remaining: 12 });
    const app = buildApp();
    const res = await request(app).post('/api/work/findings/analyze-batch').send({});
    expect(res.status).toBe(200);
    expect(analyzeDocumentFindings).toHaveBeenCalledWith(10, 'stale_docs');
    expect(res.body.remaining).toBe(12);

    await request(app).post('/api/work/findings/analyze-batch').send({ limit: 3, sweep: 'orphan_decisions' });
    expect(m(analyzeDocumentFindings).mock.calls[1]).toEqual([3, 'orphan_decisions']);
  });

  it('POST /findings/:id/dismiss 404s an unknown finding', async () => {
    m(getFinding).mockResolvedValue(null);
    const missing = await request(buildApp()).post('/api/work/findings/f-x/dismiss').send({});
    expect(missing.status).toBe(404);

    m(getFinding).mockResolvedValue({ id: 'f-1', status: 'open', jobId: null });
    m(initiativeIdForFinding).mockReturnValue(null);
    m(setFindingStatus).mockResolvedValue(true);
    const ok = await request(buildApp()).post('/api/work/findings/f-1/dismiss').send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ dismissed: true });
    expect(setFindingStatus).toHaveBeenLastCalledWith('f-1', 'dismissed');
  });
});

describe('POST /api/work/findings/:id/analyze', () => {
  it('404s an unknown finding and 400s one that does not target a document', async () => {
    m(getFinding).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/work/findings/f-x/analyze').send({})).status).toBe(404);

    m(getFinding).mockResolvedValue({ id: 'f-1', entityType: 'person', entityId: 'p-004' });
    const wrongKind = await request(buildApp()).post('/api/work/findings/f-1/analyze').send({});
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error).toMatch(/only document findings/);
    expect(wrongKind.body.error).toMatch(/targets person/);
    expect(analyzeDocumentLinks).not.toHaveBeenCalled();
  });

  it('threads dryRun through so a caller can see the proposals before writing any', async () => {
    m(getFinding).mockResolvedValue({ id: 'f-1', entityType: 'document', entityId: 'doc-1' });
    m(analyzeDocumentLinks).mockResolvedValue({ proposed: 3, links: [] });
    const res = await request(buildApp()).post('/api/work/findings/f-1/analyze').send({ dryRun: true });
    expect(res.status).toBe(200);
    expect(analyzeDocumentLinks).toHaveBeenCalledWith('doc-1', { findingId: 'f-1', dryRun: true });
    expect(res.body.proposed).toBe(3);
  });
});

// ── Graph proposals ────────────────────────────────────────────────────────

describe('graph proposals', () => {
  it('GET /proposals wraps the list and forwards a status filter only when given', async () => {
    m(listProposals).mockResolvedValue([{ id: 'gp-1', status: 'pending' }]);
    const app = buildApp();
    await request(app).get('/api/work/proposals');
    await request(app).get('/api/work/proposals?status=pending');
    expect(m(listProposals).mock.calls.map((c) => c[0])).toEqual([{}, { status: 'pending' }]);
  });

  it('POST /proposals 400s without a kind and a targetId', async () => {
    const app = buildApp();
    for (const body of [{}, { kind: 'add_skill' }, { targetId: 'p-004' }]) {
      const res = await request(app).post('/api/work/proposals').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/kind and targetId/);
    }
    expect(proposeGraphChange).not.toHaveBeenCalled();
  });

  it('POST /proposals defaults source/targetType and omits absent optionals', async () => {
    m(proposeGraphChange).mockResolvedValue({ id: 'gp-2', status: 'pending' });
    const res = await request(buildApp()).post('/api/work/proposals')
      .send({ kind: 'add_skill', targetId: 'p-004' });
    expect(res.status).toBe(201);
    const arg = m(proposeGraphChange).mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['source']).toBe('portal');
    expect(arg['targetType']).toBe('person');
    expect(arg['payload']).toEqual({});
    // Absent optionals are not spelled as undefined keys.
    for (const key of ['rationale', 'evidence', 'confidence', 'jobId', 'findingId']) {
      expect(Object.prototype.hasOwnProperty.call(arg, key)).toBe(false);
    }
  });

  it('POST /proposals 503s when the proposals store is unreachable', async () => {
    m(proposeGraphChange).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/work/proposals')
      .send({ kind: 'add_skill', targetId: 'p-004' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/proposals unavailable/);
  });

  it('POST /proposals/:id/decide refuses anything but approve/reject', async () => {
    const app = buildApp();
    for (const decision of [undefined, 'maybe']) {
      const res = await request(app).post('/api/work/proposals/gp-1/decide').send({ decision });
      expect(res.status).toBe(400);
    }
    expect(decideProposal).not.toHaveBeenCalled();
  });

  it('POST /proposals/:id/decide records the SESSION as reviewer, and 404s a decided one', async () => {
    m(decideProposal).mockResolvedValue({ id: 'gp-1', status: 'approved' });
    const ok = await request(buildApp()).post('/api/work/proposals/gp-1/decide')
      .send({ decision: 'approve', note: 'looks right', reviewer: 'forged' });
    expect(ok.status).toBe(200);
    expect(decideProposal).toHaveBeenCalledWith('gp-1', 'approve', { reviewer: 'u-nora', note: 'looks right' });

    m(decideProposal).mockResolvedValue(null);
    const gone = await request(buildApp()).post('/api/work/proposals/gp-1/decide').send({ decision: 'reject' });
    expect(gone.status).toBe(404);
    expect(gone.body.error).toMatch(/already decided/);
  });

  it('falls back to "portal" as reviewer for an unauthenticated caller', async () => {
    m(decideProposal).mockResolvedValue({ id: 'gp-1' });
    await request(buildApp(null)).post('/api/work/proposals/gp-1/decide').send({ decision: 'approve' });
    expect((m(decideProposal).mock.calls[0]![2] as { reviewer: string }).reviewer).toBe('portal');
  });
});

describe('initiative scope on job lifecycle (DE-44 rows 7–8)', () => {
  beforeEach(() => { scopeDeny.clear(); scopeCalls.length = 0; });
  afterEach(() => { scopeDeny.clear(); });

  it('refuses review, requeue and cancel of a job serving someone else\'s initiative; requeue asks the spend question', async () => {
    m(getJob).mockResolvedValue({ id: 'job-1', status: 'failed', payload: { initiativeId: 'p-billing' } });
    scopeDeny.add('p-billing');
    expect((await request(buildApp()).post('/api/work/jobs/job-1/review').send({ decision: 'accept' })).status).toBe(403);
    expect((await request(buildApp()).post('/api/work/jobs/job-1/requeue').send({})).status).toBe(403);
    expect((await request(buildApp()).delete('/api/work/jobs/job-1')).status).toBe(403);
    expect(reviewJob).not.toHaveBeenCalled();
    expect(requeueJob).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
    expect((scopeCalls[1]!.opts as { spend?: boolean }).spend).toBe(true);
  });

  it('refuses to dismiss a finding on someone else\'s initiative (DE-44 row 9)', async () => {
    m(getFinding).mockResolvedValue({ id: 'f-1', status: 'open', jobId: null });
    m(initiativeIdForFinding).mockReturnValue('p-billing');
    scopeDeny.add('p-billing');
    expect((await request(buildApp()).post('/api/work/findings/f-1/dismiss').send({})).status).toBe(403);
    expect(setFindingStatus).not.toHaveBeenCalled();
  });

  it('a job with no initiative is not scoped', async () => {
    m(getJob).mockResolvedValue({ id: 'job-1', status: 'awaiting_review', payload: {} });
    m(reviewJob).mockResolvedValue({ id: 'job-1', status: 'done' });
    expect((await request(buildApp()).post('/api/work/jobs/job-1/review').send({ decision: 'accept' })).status).toBe(200);
    expect(scopeCalls[0]!.initiativeId).toBeNull();
  });
});

// docs/microvm-runner-design.md §10 item 2 / §9: the actor a microVM run acts
// as is the SESSION's subject, never the body's, and a resume is named by id.
describe('POST /api/work/jobs — the microVM runner\'s actor and resume', () => {
  const JOB = { id: 'job-1', status: 'queued', payload: {} };

  it('takes actorSub from the session and ignores one in the body', async () => {
    m(enqueueJob).mockResolvedValue(JOB);
    const res = await request(buildApp()).post('/api/work/jobs')
      .send({ title: 't', prompt: 'p', actorSub: 'u-someone-else', actor_sub: 'u-someone-else' });
    expect(res.status).toBe(201);
    expect(m(enqueueJob).mock.calls[0]![0]).toMatchObject({ actorSub: 'u-nora' });
    expect(JSON.stringify(m(enqueueJob).mock.calls[0]![0])).not.toContain('u-someone-else');
  });

  it('passes a resumeOfJobId through for the dispatcher to judge, and 400s a malformed one', async () => {
    m(enqueueJob).mockResolvedValue(JOB);
    const ok = await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p', resumeOfJobId: 'job-abc-123' });
    expect(ok.status).toBe(201);
    expect(m(enqueueJob).mock.calls[0]![0]).toMatchObject({ resumeOfJobId: 'job-abc-123' });
    const bad = await request(buildApp()).post('/api/work/jobs').send({ title: 't', prompt: 'p', resumeOfJobId: '../job' });
    expect(bad.status).toBe(400);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });
});
