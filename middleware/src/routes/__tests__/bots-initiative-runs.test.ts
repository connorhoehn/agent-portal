// GET /api/bots/initiative-runs — the initiative page's Agents tab for any
// signed-in reader. A member opening LLM Application Platform saw "no runs"
// because the tab read the bot roster and run history, both gated on bot
// administration. The runs on an initiative are work-queue facts (the queue
// is a session floor); bot CONFIGURATION is not. This pins both halves: the
// route answers a session that every gated read refuses, and its body carries
// each bot's id and name and nothing of its configuration.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
// A member: every capability gate refuses, the session floor admits.
const sessionLabels: string[] = [];
jest.mock('../../lib/authz.js', () => {
  const deny = () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(403).json({ error: 'Forbidden' });
  };
  return {
    readForRolesElseAction: deny,
    requireAction: deny,
    requireSession: (label: string) => {
      sessionLabels.push(label);
      return (_req: unknown, _res: unknown, next: () => void) => next();
    },
  };
});
jest.mock('../../lib/devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(async () => null), devboxDataClient: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({
  registerBox: jest.fn(() => ({ id: 'box-test', sessionId: 's' })), getBoxBySession: jest.fn(() => null), appendEvent: jest.fn(),
}));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __resetMockRuns, listBotsResult } from '../../providers/bots.js';
import { getMaintenance30d } from '../../providers/budgets.js';

beforeEach(() => __resetMockRuns());

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-release', role: 'member', tenant: 'orgiq' };
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /api/bots/initiative-runs — a member on an initiative', () => {
  it('is a session floor, not a bot-administration gate', () => {
    expect(sessionLabels).toContain('InitiativeRuns');
  });

  it('carries the 30-day maintenance floor as the view states it, decided on the server (never summed in the browser)', async () => {
    const res = await request(buildApp()).get('/api/bots/initiative-runs?orgProjectId=p-llm-platform');
    expect(res.status).toBe(200);
    const expected = await getMaintenance30d('p-llm-platform');
    expect(res.body.maintenance30d).toEqual(expected);
    expect(typeof res.body.maintenance30d.cronRuns).toBe('number');
    expect(typeof res.body.maintenance30d.costUsd).toBe('number');
    // Costed cron runs only: an uncosted (in-flight) cron run adds no money and is not counted — the view's own rule.
    const cron = (res.body.runs as Array<{ trigger: string; costUsd: number | null }>).filter((r) => r.trigger === 'cron');
    expect(res.body.maintenance30d.cronRuns).toBeLessThanOrEqual(cron.length);
  });

  it('lists the runs of the bots pointed at the initiative while the roster stays refused', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/bots')).status).toBe(403);
    expect((await request(app).get('/api/bots/runs?botIds=x')).status).toBe(403);

    const res = await request(app).get('/api/bots/initiative-runs?orgProjectId=p-llm-platform');
    expect(res.status).toBe(200);
    const roster = (await listBotsResult()).items.filter((b) => b.orgProjectId === 'p-llm-platform');
    expect(roster.length).toBeGreaterThan(0);
    expect(res.body.bots).toEqual(roster.map((b) => ({ id: b.id, name: b.name })));
    expect(res.body.runs.length).toBeGreaterThan(0);
    const ids = new Set(roster.map((b) => b.id));
    for (const run of res.body.runs) expect(run.botId === null || ids.has(run.botId)).toBe(true);
  });

  it('carries no bot configuration', async () => {
    const res = await request(buildApp()).get('/api/bots/initiative-runs?orgProjectId=p-llm-platform');
    for (const bot of res.body.bots) expect(Object.keys(bot).sort()).toEqual(['id', 'name']);
    const body = JSON.stringify(res.body);
    const [bot] = (await listBotsResult()).items.filter((b) => b.orgProjectId === 'p-llm-platform');
    expect(body).not.toContain(bot!.prompt);
    for (const key of ['"prompt"', '"cronExpr"', '"budgetPerRunUsd"', '"budgetPerDayUsd"', '"model"', '"requiresReview"']) {
      expect(body).not.toContain(key);
    }
  });

  it('answers an initiative with no bots and no runs with an empty list, and refuses a missing id', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/bots/initiative-runs?orgProjectId=p-does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: [], bots: [], maintenance30d: { cronRuns: 0, costUsd: 0 } });
    expect((await request(app).get('/api/bots/initiative-runs')).status).toBe(400);
  });
});
