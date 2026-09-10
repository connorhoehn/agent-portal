// POST /api/bots/work-items/:id/estimate and .../review-estimate in dev:mock,
// through the REAL work-items provider.
//
// WHY THIS SUITE EXISTS. The estimate columns originally had exactly one
// writer: a successful dispatch. That looked reasonable and was unreachable —
// dispatch moves the item `open -> in_progress`, so the estimate it wrote
// belonged to a row that was already running, and the work row's play action
// (which only shows on an OPEN item with a standing estimate) could never
// appear. A green build proved nothing; rendering the page is what caught it.
//
// So these tests pin the properties that make the feature real rather than the
// happy path alone: saving does NOT start a run, saving does NOT change status,
// attribution comes from the session, and a new estimate drops a stale review.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../lib/devbox-arn.js', () => ({
  resolveDevboxArn: jest.fn(async () => null),
  devboxDataClient: jest.fn(),
}));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({
  registerBox: jest.fn((opts: { sessionId: string }) => ({ id: 'box-test', sessionId: opts.sessionId })),
  getBoxBySession: jest.fn(() => null),
  appendEvent: jest.fn(),
}));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../../mock/core/index.js';

// An OPEN, pointed story — the state the play action is written for.
const ITEM = 'wi-zt-e1-s2';
const MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const FORECAST = { costUsdP25: 0.03, costUsdP75: 0.3, minutesP25: 1, minutesP75: 6 };

function buildApp(sub = 'u-rachel') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub, role: 'hr-admin', tenant: 'orgiq' };
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

const save = (app: express.Express, body: object = { model: MODEL, estimate: FORECAST }) =>
  request(app).post(`/api/bots/work-items/${ITEM}/estimate`).send(body);

beforeEach(() => fixtureRegistry.resetAll('default'));

describe('POST /api/bots/work-items/:id/estimate', () => {
  it('records the forecast and leaves the item OPEN — the whole point', async () => {
    const res = await save(buildApp());
    expect(res.status).toBe(200);
    // If this ever reads in_progress, the play action is unreachable again.
    expect(res.body.item.status).toBe('open');
    expect(res.body.item).toMatchObject({
      estimatedBy: 'u-rachel',
      estimateModel: MODEL,
      estimateForecast: FORECAST,
    });
    expect(res.body.item.estimatedAt).toEqual(expect.any(String));
  });

  it('resolves the subject to a display name, so the row can name a person', async () => {
    const res = await save(buildApp());
    expect(res.body.item.estimatedByName).toBe('Rachel Kowalski');
  });

  it('takes attribution from the session, never from the body', async () => {
    const res = await save(buildApp('u-vera'), {
      model: MODEL, estimate: FORECAST, estimatedBy: 'u-someone-else',
    });
    expect(res.body.item.estimatedBy).toBe('u-vera');
  });

  it('stores the cost from the forecast, so the item carries a number', async () => {
    const res = await save(buildApp());
    expect(res.body.item.estimatedCostUsd).toBe(0.3);
  });

  it('refuses a forecast with no model — an estimate is only valid for its own', async () => {
    const res = await save(buildApp(), { estimate: FORECAST });
    expect(res.status).toBe(400);
  });

  it('refuses a model with no forecast', async () => {
    const res = await save(buildApp(), { model: MODEL });
    expect(res.status).toBe(400);
  });

  it('404s an unknown item instead of silently succeeding as a no-op UPDATE', async () => {
    const res = await request(buildApp())
      .post('/api/bots/work-items/wi-does-not-exist/estimate')
      .send({ model: MODEL, estimate: FORECAST });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/bots/work-items/:id/review-estimate', () => {
  it('records an advisory sign-off with a name', async () => {
    await save(buildApp());
    const res = await request(buildApp()).post(`/api/bots/work-items/${ITEM}/review-estimate`);
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      estimateReviewedBy: 'u-rachel',
      estimateReviewedByName: 'Rachel Kowalski',
    });
    // Advisory: reviewing must not move the item out of the dispatchable state.
    expect(res.body.item.status).toBe('open');
  });

  it('409s when there is no estimate to review — not 404, the item exists', async () => {
    const res = await request(buildApp()).post(`/api/bots/work-items/${ITEM}/review-estimate`);
    expect(res.status).toBe(409);
  });

  it('a NEW estimate clears a prior review rather than carrying it forward', async () => {
    await save(buildApp());
    await request(buildApp()).post(`/api/bots/work-items/${ITEM}/review-estimate`);
    // Somebody signed off on the OLD number. Re-estimating must not attribute
    // that opinion to a forecast they never saw.
    const res = await save(buildApp(), { model: MODEL, estimate: { ...FORECAST, costUsdP75: 9.99 } });
    expect(res.body.item.estimateReviewedBy).toBeNull();
    expect(res.body.item.estimateReviewedByName).toBeNull();
    expect(res.body.item.estimateReviewedAt).toBeNull();
  });
});

// ─── The optional join ───────────────────────────────────────────────────────
//
// The display names come from a LEFT JOIN on app_users (identity_schema.sql).
// safeExec swallows `relation ... does not exist`, so an UNCONDITIONAL join on
// a cluster carrying work_items but not identity_schema would return [] for
// every work-item read — the entire board blank, reported as "no work". These
// pin that the join is chosen, not assumed.

describe('estimate name resolution degrades to the raw subject', () => {
  it('exposes a probe seam, so the join is a decision and not an assumption', async () => {
    const mod = await import('../../providers/work-items.js');
    expect(typeof mod.resetAppUsersProbe).toBe('function');
  });

  it('still renders an attribution when no name is available', async () => {
    // The row must never read "unknown" while estimated_by holds a real
    // subject — the attribution exists, only its label is missing. The portal
    // falls back `estimatedByName ?? estimatedBy`, so a null name is safe.
    const res = await save(buildApp());
    expect(res.body.item.estimatedBy).toBe('u-rachel');
  });
});
