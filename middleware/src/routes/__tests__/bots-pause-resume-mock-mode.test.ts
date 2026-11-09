// POST /api/bots/:id/pause and /resume in dev:mock, through the REAL bots
// provider (not seam-mocked) — DEFECTS.md sme #10.
//
// Before this fix, providers/bots.ts's setPausedReason()/updateBot() returned
// early under config.mock.aurora, so the route re-read the SAME unmodified
// bot right after "changing" it: pause answered 200 with `enabled: true,
// pausedReason: null` no matter what was asked, and the portal's "✓ Paused"
// toast was a lie the status pill never caught up to. This pins that the
// mock bot's own state — the same object listBots()/getBot() read — actually
// flips, and flips back cleanly on resume.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// The live cron registry is a different concern (pinned in bot-scheduler's
// own tests) — no-op it so this suite is purely about the persisted state.
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
// Modules this suite never touches, stubbed only so the route module graph
// loads under the CJS test transform (several use import.meta).
jest.mock('../../providers/agent-jobs.js', () => ({ enqueueJob: jest.fn() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(async () => null), devboxDataClient: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({ registerBox: jest.fn(), getBoxBySession: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { MOCK_BOTS } from '../../providers/bots.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-rachel', role: 'hr-admin', tenant: 'orgiq' };
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

// dev:mock enables every seeded bot (mock/bots.ts; rag-index-health keeps the
// shipped RAG index fresh). The pause tests below drive a live bot; the resume
// test parks rag-index-health the way a disabled seed row would and brings it up.
// obs-nightly-maintenance — the bot this suite drives through the cycle.
const RUNNING_BOT_ID = '32970d0a-e28e-5100-8fb0-a5cbb87dac99';
// rag-index-health — parked, then resumed, below.
const PARKED_BOT_ID = 'f595b10b-5f52-50d0-81a0-9117e9334fb4';

describe('POST /api/bots/:id/pause and /resume (dev:mock)', () => {
  // MOCK_BOTS is a shared singleton the provider mutates in place — restore
  // both bots to their seeded state so this suite has no order dependency on
  // any other test in the same process.
  const before = new Map(MOCK_BOTS.map((b) => [b.id, { enabled: b.enabled, pausedReason: b.pausedReason }]));
  afterEach(() => {
    for (const bot of MOCK_BOTS) {
      const snap = before.get(bot.id);
      if (snap) { bot.enabled = snap.enabled; bot.pausedReason = snap.pausedReason; }
    }
  });

  it('pause sets a real pausedReason instead of no-opping', async () => {
    const res = await request(buildApp()).post(`/api/bots/${RUNNING_BOT_ID}/pause`).send({});
    expect(res.status).toBe(200);
    expect(res.body.bot.pausedReason).toBe('paused by operator');
    // The response is a live re-read, not an echo of the request — proof the
    // route did not just report success.
    expect(res.body.bot).toEqual(MOCK_BOTS.find((b) => b.id === RUNNING_BOT_ID));
  });

  it('pause accepts a custom reason', async () => {
    const res = await request(buildApp())
      .post(`/api/bots/${RUNNING_BOT_ID}/pause`).send({ reason: 'investigating a cost spike' });
    expect(res.body.bot.pausedReason).toBe('investigating a cost spike');
  });

  it('resume clears the pausedReason and the toast-truth round-trips: GET reflects it too', async () => {
    const app = buildApp();
    await request(app).post(`/api/bots/${RUNNING_BOT_ID}/pause`).send({});
    const resumeRes = await request(app).post(`/api/bots/${RUNNING_BOT_ID}/resume`).send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.bot.pausedReason).toBeNull();
    expect(resumeRes.body.bot.enabled).toBe(true);

    const getRes = await request(app).get(`/api/bots/${RUNNING_BOT_ID}`);
    expect(getRes.body.bot.pausedReason).toBeNull();
    expect(getRes.body.bot.enabled).toBe(true);
  });

  it('resume also re-enables a bot that was parked disabled from the seed (not just self-paused)', async () => {
    // The seed runs every bot now, so park one the way a seed row would
    // (disabled, with a reason); afterEach restores it.
    const parked = MOCK_BOTS.find((b) => b.id === PARKED_BOT_ID)!;
    parked.enabled = false;
    parked.pausedReason = 'Parked: the initiative shipped.';

    const res = await request(buildApp()).post(`/api/bots/${PARKED_BOT_ID}/resume`).send({});
    expect(res.status).toBe(200);
    expect(res.body.bot.enabled).toBe(true);
    expect(res.body.bot.pausedReason).toBeNull();
  });

  it('404s pausing/resuming a bot id that does not exist', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/bots/no-such-bot/pause').send({})).status).toBe(404);
    expect((await request(app).post('/api/bots/no-such-bot/resume').send({})).status).toBe(404);
  });
});
