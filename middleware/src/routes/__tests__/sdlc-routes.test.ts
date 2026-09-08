// AI SDLC governance — /api/sdlc (routes/sdlc.ts). The surface for code an
// agent wrote: policies, change requests, the human decision, the re-review,
// the "address the feedback" loop, and delivery.
//
// What is pinned:
//   * GET /policies SEEDS the defaults on first read, so a fresh environment
//     is governed rather than wide open the moment someone opens the page —
//     and a seeding failure still lets the list render,
//   * the policy `kind` allow-list, and that an unknown kind is refused with
//     the valid ones NAMED,
//   * `action` defaults to require_approval: only the literal 'block' blocks,
//     so a typo cannot silently turn a gate into a hard stop,
//   * the decision is attributed to the SESSION, never the body,
//   * the loop-closing rule on /address: the agent is handed the REVIEWER'S
//     OWN words (summary + findings), not a paraphrase, and an already-approved
//     change has nothing to address,
//   * the status codes that carry meaning: 202 for a dispatched run (work
//     started, not finished), 503 when the devbox runtime is absent, 409 when
//     delivery itself was refused,
//   * the wire envelopes (`{policies}` / `{changes}` / `{change}`).

jest.mock('../../providers/sdlc.js', () => ({
  listPolicies: jest.fn(), upsertPolicy: jest.fn(), deletePolicy: jest.fn(),
  seedDefaultPolicies: jest.fn(), listChangeRequests: jest.fn(), getChangeRequest: jest.fn(),
  decideChange: jest.fn(), evaluateChange: jest.fn(), recordReview: jest.fn(),
  markInReview: jest.fn(),
}));
jest.mock('../../lib/change-reviewer.js', () => ({ reviewDiff: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({
  deliverApprovedChange: jest.fn(), dispatchGovernedRun: jest.fn(),
}));
jest.mock('../../providers/agent-projects.js', () => ({
  getAgentProject: jest.fn(), checkoutPath: jest.fn(() => '/mnt/workspace/repo'),
}));
jest.mock('../../lib/devbox-arn.js', () => ({
  resolveDevboxArn: jest.fn(), devboxDataClient: jest.fn(() => ({})),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { sdlcRouter } from '../sdlc.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listPolicies, upsertPolicy, deletePolicy, seedDefaultPolicies,
  listChangeRequests, getChangeRequest, decideChange, evaluateChange,
  recordReview, markInReview,
} from '../../providers/sdlc.js';
import { reviewDiff } from '../../lib/change-reviewer.js';
import { deliverApprovedChange, dispatchGovernedRun } from '../../lib/sdlc-pipeline.js';
import { getAgentProject } from '../../providers/agent-projects.js';
import { resolveDevboxArn } from '../../lib/devbox-arn.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const CHANGE = {
  id: 'cr-1', projectId: 'ap-1', title: 'Add retry to the Data API call',
  status: 'changes_requested', diff: 'diff --git a b', diffTruncated: false,
  reviews: [{
    model: 'amazon.nova-pro-v1:0', verdict: 'changes_requested',
    summary: 'Retry is unbounded.',
    findings: [
      { file: 'src/a.ts', line: 12, note: 'cap the retries' },
      { file: null, line: null, note: 'add a test' },
    ],
  }],
};

const PROJECT = {
  id: 'ap-1', sessionId: 'sess-'.padEnd(40, 'x'), repoFullName: 'org/repo',
  defaultBranch: 'main', connectionName: 'orgiq-github-org',
};

function buildApp(session: Record<string, unknown> | null = { sub: 'u-nora' }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/sdlc', sdlcRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(seedDefaultPolicies).mockResolvedValue(undefined);
});

describe('GET /policies', () => {
  it('seeds the defaults BEFORE listing, so a fresh environment is governed', async () => {
    m(listPolicies).mockResolvedValue([{ id: 'p-1', kind: 'require_review', enabled: true }]);
    const res = await request(buildApp()).get('/api/sdlc/policies');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['policies']);
    expect(m(seedDefaultPolicies).mock.invocationCallOrder[0]!)
      .toBeLessThan(m(listPolicies).mock.invocationCallOrder[0]!);
  });

  it('still lists when seeding fails — best-effort, not a prerequisite', async () => {
    m(seedDefaultPolicies).mockRejectedValue(new Error('Data API cold start'));
    m(listPolicies).mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/sdlc/policies');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ policies: [] });
  });
});

describe('POST /policies', () => {
  it('requires a name and refuses an unknown kind, NAMING the valid ones', async () => {
    const app = buildApp();
    const noName = await request(app).post('/api/sdlc/policies').send({ kind: 'max_files' });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/name is required/);

    const badKind = await request(app).post('/api/sdlc/policies').send({ name: 'x', kind: 'vibes' });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toMatch(/require_review, protected_paths, max_files, model_allowlist, max_cost/);
    expect(upsertPolicy).not.toHaveBeenCalled();
  });

  it('defaults action to require_approval — only the literal "block" blocks', async () => {
    // A typo must not silently turn a gate that asks for a human into a hard
    // stop, or into one that no longer asks.
    m(upsertPolicy).mockResolvedValue({ id: 'p-2' });
    const app = buildApp();
    await request(app).post('/api/sdlc/policies').send({ name: 'a', kind: 'max_files' });
    // Bound to a local, not inline: this is request INPUT, and the wire sweep
    // reads an inline `action:` string on a policy-shaped literal as a fixture
    // claiming a value the server sends.
    const typo = 'blocK';
    await request(app).post('/api/sdlc/policies').send({ name: 'a', kind: 'max_files', action: typo });
    await request(app).post('/api/sdlc/policies').send({ name: 'a', kind: 'max_files', action: 'block' });
    expect(m(upsertPolicy).mock.calls.map((c) => (c[0] as { action: string }).action))
      .toEqual(['require_approval', 'require_approval', 'block']);
  });

  it('creates with 201, trimming the name and defaulting enabled + config', async () => {
    m(upsertPolicy).mockResolvedValue({ id: 'p-3' });
    const res = await request(buildApp()).post('/api/sdlc/policies')
      .send({ name: '  Cap files  ', kind: 'max_files' });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['policy']);
    expect(m(upsertPolicy).mock.calls[0]![0]).toEqual({
      name: 'Cap files', enabled: true, kind: 'max_files',
      config: {}, action: 'require_approval',
    });
  });

  it('threads an explicit id through so the same route updates in place', async () => {
    m(upsertPolicy).mockResolvedValue({ id: 'p-1' });
    await request(buildApp()).post('/api/sdlc/policies')
      .send({ id: 'p-1', name: 'a', kind: 'max_cost', enabled: false, config: { usd: 5 } });
    expect(m(upsertPolicy).mock.calls[0]![0]).toMatchObject({
      id: 'p-1', enabled: false, config: { usd: 5 },
    });
  });
});

describe('DELETE /policies/:id', () => {
  it('404s an unknown policy and 200s a removal', async () => {
    m(deletePolicy).mockResolvedValue(false);
    const missing = await request(buildApp()).delete('/api/sdlc/policies/p-x');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/No such policy/);

    m(deletePolicy).mockResolvedValue(true);
    const ok = await request(buildApp()).delete('/api/sdlc/policies/p-1');
    expect(ok.body).toEqual({ ok: true });
  });
});

describe('GET /changes', () => {
  it('forwards projectId and the open flag only when they are set', async () => {
    m(listChangeRequests).mockResolvedValue([CHANGE]);
    const app = buildApp();
    const all = await request(app).get('/api/sdlc/changes');
    expect(Object.keys(all.body)).toEqual(['changes']);

    await request(app).get('/api/sdlc/changes?projectId=ap-1&open=true');
    await request(app).get('/api/sdlc/changes?open=false');
    expect(m(listChangeRequests).mock.calls.map((c) => c[0]))
      .toEqual([{}, { projectId: 'ap-1', open: true }, {}]);
  });

  it('GET /changes/:id 404s an unknown change', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/sdlc/changes/cr-x');
    expect(res.status).toBe(404);

    m(getChangeRequest).mockResolvedValue(CHANGE);
    const ok = await request(buildApp()).get('/api/sdlc/changes/cr-1');
    expect(Object.keys(ok.body)).toEqual(['change']);
    expect(ok.body.change.reviews[0].verdict).toBe('changes_requested');
  });
});

describe('POST /changes/:id/decide', () => {
  it('refuses anything but approve/reject', async () => {
    const app = buildApp();
    for (const decision of [undefined, 'maybe', 'Approve']) {
      const res = await request(app).post('/api/sdlc/changes/cr-1/decide').send({ decision });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/decision must be approve or reject/);
    }
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('attributes the decision to the SESSION, not the body', async () => {
    m(decideChange).mockResolvedValue({ ok: true, status: 'approved' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/decide')
      .send({ decision: 'approve', note: 'ship it', by: 'somebody-else' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'approved' });
    expect(decideChange).toHaveBeenCalledWith('cr-1', 'approve', { by: 'u-nora', note: 'ship it' });
  });

  it('records a null decider for an unauthenticated caller rather than inventing one', async () => {
    m(decideChange).mockResolvedValue({ ok: true, status: 'rejected' });
    await request(buildApp(null)).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'reject' });
    expect((m(decideChange).mock.calls[0]![2] as { by: string | null }).by).toBeNull();
  });

  it('400s with the provider\'s own reason when the decision was refused', async () => {
    m(decideChange).mockResolvedValue({ ok: false, error: 'change is already delivered' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('change is already delivered');
  });
});

describe('POST /changes/:id/rereview', () => {
  it('404s an unknown change and refuses one with no stored diff', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-x/rereview').send({})).status).toBe(404);

    m(getChangeRequest).mockResolvedValue({ ...CHANGE, diff: null });
    const noDiff = await request(buildApp()).post('/api/sdlc/changes/cr-1/rereview').send({});
    expect(noDiff.status).toBe(400);
    expect(noDiff.body.error).toMatch(/no stored diff/);
    expect(reviewDiff).not.toHaveBeenCalled();
  });

  it('marks in-review, re-reviews the STORED diff, records it, then re-evaluates', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(reviewDiff).mockResolvedValue({
      model: 'amazon.nova-pro-v1:0', verdict: 'approve', summary: 'fixed', findings: [],
    });
    m(evaluateChange).mockResolvedValue({ status: 'approved' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/rereview').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, verdict: 'approve', status: 'approved' });

    // No new agent run — the diff is already captured, which is the point.
    expect(m(reviewDiff).mock.calls[0]![0]).toEqual({
      title: CHANGE.title, diff: CHANGE.diff, truncated: false, taskPrompt: null,
    });
    const order = [
      m(markInReview).mock.invocationCallOrder[0]!,
      m(reviewDiff).mock.invocationCallOrder[0]!,
      m(recordReview).mock.invocationCallOrder[0]!,
      m(evaluateChange).mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('POST /changes/:id/address', () => {
  it('refuses when there is nothing to address', async () => {
    const app = buildApp();
    m(getChangeRequest).mockResolvedValue({ ...CHANGE, reviews: [] });
    const noReview = await request(app).post('/api/sdlc/changes/cr-1/address').send({});
    expect(noReview.status).toBe(400);
    expect(noReview.body.error).toMatch(/no review feedback to address/);

    m(getChangeRequest).mockResolvedValue({
      ...CHANGE, reviews: [{ ...CHANGE.reviews[0]!, verdict: 'approve' }],
    });
    const approved = await request(app).post('/api/sdlc/changes/cr-1/address').send({});
    expect(approved.status).toBe(400);
    expect(dispatchGovernedRun).not.toHaveBeenCalled();
  });

  it('hands the agent the REVIEWER\'S OWN words, file:line and all', async () => {
    // The loop only closes if the agent is fixing the stated objections rather
    // than guessing what "changes requested" meant.
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(dispatchGovernedRun).mockResolvedValue({ ok: true, runId: 'run-9' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({ model: 'nova-pro' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, runId: 'run-9' });

    const prompt = (m(dispatchGovernedRun).mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('Retry is unbounded.');
    expect(prompt).toContain('- src/a.ts:12: cap the retries');
    expect(prompt).toContain('- add a test');
    expect(prompt).toContain(CHANGE.title);
    expect(prompt).toMatch(/Do not revert your earlier work/);
    expect((m(dispatchGovernedRun).mock.calls[0]![0] as { model: string }).model).toBe('nova-pro');
  });

  it('refuses a project with no live workspace, and 404s one that is gone', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({})).status).toBe(404);

    m(getAgentProject).mockResolvedValue({ ...PROJECT, sessionId: null });
    const noWorkspace = await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({});
    expect(noWorkspace.status).toBe(400);
    expect(noWorkspace.body.error).toMatch(/re-clone it/);
    expect(dispatchGovernedRun).not.toHaveBeenCalled();
  });

  it('503s when the run could not be dispatched', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(dispatchGovernedRun).mockResolvedValue({ ok: false, error: 'devbox runtime not deployed' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('devbox runtime not deployed');
  });
});

describe('POST /changes/:id/deliver', () => {
  it('404s an unknown change or a vanished project', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-x/deliver').send({})).status).toBe(404);

    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({})).status).toBe(404);
    expect(deliverApprovedChange).not.toHaveBeenCalled();
  });

  it('503s — not 500 — when the devbox runtime is not deployed', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(resolveDevboxArn).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/devbox runtime is not deployed/);
    expect(deliverApprovedChange).not.toHaveBeenCalled();
  });

  it('delivers with the project\'s own checkout + repo identity and returns the PR url', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(resolveDevboxArn).mockResolvedValue('arn:devbox');
    m(deliverApprovedChange).mockResolvedValue({ ok: true, prUrl: 'https://github.com/org/repo/pull/7' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, prUrl: 'https://github.com/org/repo/pull/7' });
    expect(m(deliverApprovedChange).mock.calls[0]![0]).toMatchObject({
      runtimeArn: 'arn:devbox', changeId: 'cr-1',
      project: {
        sessionId: PROJECT.sessionId, checkout: '/mnt/workspace/repo',
        repoFullName: 'org/repo', defaultBranch: 'main', connectionName: 'orgiq-github-org',
      },
    });
  });

  it('409s a refused delivery with its own reason', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(resolveDevboxArn).mockResolvedValue('arn:devbox');
    m(deliverApprovedChange).mockResolvedValue({ ok: false, error: 'change is not approved' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('change is not approved');
  });
});
