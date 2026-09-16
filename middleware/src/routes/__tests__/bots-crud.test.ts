// Bots CRUD + manual firing — /api/bots (routes/bots.ts). The six routes the
// dispatch/pause/resume suites do not reach.
//
// What is pinned:
//   * the SHAPE CHECKS the SQL layer cannot express as a 400. A non-UUID
//     agentProjectId dies in a `::uuid` cast, a string budget dies in the
//     NUMERIC bind and a fractional maxRunsPerDay corrupts the run cap — all
//     500s the operator cannot act on. They are validated on create AND patch,
//     so garbage never reaches Aurora,
//   * PATCH validating the shape the bot will HAVE, not the patch alone:
//     switching trigger to cron must fail without a cron expression even when
//     the patch itself carries neither field,
//   * that every mutation re-registers with the LIVE scheduler. A bot whose
//     cron only exists in processes booted after the edit looks armed
//     everywhere and silently never fires,
//   * the per-run budget brake on manual firing: over budget answers 409 with
//     the ESTIMATE attached (so the operator sees what they are confirming)
//     and clears only on `confirmOverRunBudget` — the same word dispatch-work
//     uses, because it is the same gate,
//   * that a hand-driven firing records WHO fired it, from the session — a
//     sprint envelope can only be burned down against a person if it does,
//   * the gate tiers the router's header sets out: reads are role-fast-pathed
//     to ManageBots, CRUD is ManageBots, and the marketplace reads ride
//     DispatchAgentRun so an SME is not locked out of the thing they exist to do.

const readGateArgs: Array<[string[], string]> = [];
const actionGates: string[] = [];
const sessionGates: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: (roles: string[], action: string) => {
    readGateArgs.push([roles, action]);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireAction: (action: string) => {
    actionGates.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  // The authentication floor — a label, not a capability. Recorded separately
  // from actionGates so a route that only needs a session is never mistaken
  // for one that carries a capability gate.
  requireSession: (label: string) => {
    sessionGates.push(label);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../providers/bots.js', () => ({
  listActiveRuns: jest.fn(),
  listBots: jest.fn(), listBotsResult: jest.fn(), listBotRunsResult: jest.fn(),
  listBotRunsForBotsResult: jest.fn(),
  getBot: jest.fn(), createBot: jest.fn(), updateBot: jest.fn(),
  deleteBot: jest.fn(), setPausedReason: jest.fn(), listBotRuns: jest.fn(),
  listMarketplaceRuns: jest.fn(), runCostSamples: jest.fn(), perPointCostSamples: jest.fn(),
}));
jest.mock('../../lib/bot-runner.js', () => ({
  fireBot: jest.fn(), dispatchWorkItem: jest.fn(), preflightWorkItem: jest.fn(),
  decideRunBudget: jest.fn(), decideAllocation: jest.fn(), decideEnvelope: jest.fn(),
  loadEnvelope: jest.fn(), grantScopedDispatchVerdict: jest.fn(),
}));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../providers/budgets.js', () => ({ getBudget: jest.fn() }));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn() }));
jest.mock('../../lib/marketplace-estimate.js', () => ({ selectDispatchForecast: jest.fn() }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listBotsResult, getBot, createBot, updateBot, deleteBot, listBotRunsResult,
  listBotRunsForBotsResult,
  runCostSamples, perPointCostSamples,
} from '../../providers/bots.js';
import { fireBot, decideRunBudget } from '../../lib/bot-runner.js';
import { registerBot, unregisterBot } from '../../lib/bot-scheduler.js';
import { validateCronExpr } from '../../lib/ingest-scheduler.js';
import { selectDispatchForecast } from '../../lib/marketplace-estimate.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BOT = {
  id: 'bot-1', name: 'Nightly lint', template: 'bug', prompt: 'fix lint',
  model: 'amazon.nova-pro-v1:0', trigger: 'manual', cronExpr: null,
  agentProjectId: null, orgProjectId: 'p-observability', enabled: true,
  budgetPerRunUsd: null, budgetPerDayUsd: null, maxRunsPerDay: 4, requiresReview: true,
};
const VALID_CREATE = {
  name: '  Nightly lint  ', template: 'bug', prompt: '  fix lint  ',
  model: '  amazon.nova-pro-v1:0  ', trigger: 'manual',
};

function buildApp(session: Record<string, unknown> | null = { sub: 'u-nora', role: 'sme' }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(validateCronExpr).mockReturnValue(true);
  m(runCostSamples).mockResolvedValue([]);
  m(perPointCostSamples).mockResolvedValue([]);
  m(selectDispatchForecast).mockReturnValue({
    estimate: { costUsdP25: 0.4, costUsdP75: 1.2 }, basis: 'model-history',
  });
});

describe('the gate tiers', () => {
  it('fast-paths reads for the operational roles, falling back to ManageBots', () => {
    expect(readGateArgs).toContainEqual([['org-leader', 'hr-admin', 'program-owner'], 'ManageBots']);
    // The marketplace reads ride the DISPATCH authority instead, so an SME who
    // may dispatch can see what it will cost first.
    expect(readGateArgs).toContainEqual([['org-leader', 'hr-admin'], 'DispatchAgentRun']);
  });

  it('gates bot CRUD on ManageBots, not on the devbox capability', () => {
    // Authoring a standing mission is its own authority and no longer implies
    // the microVM surface.
    expect(actionGates).toContain('ManageBots');
    expect(actionGates).toContain('DispatchAgentRun');
    expect(actionGates).not.toContain('ManageDevbox');
  });
});

describe('GET /api/bots', () => {
  it('wraps the roster', async () => {
    m(listBotsResult).mockResolvedValue({ items: [BOT] });
    const res = await request(buildApp()).get('/api/bots');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['bots']);
    expect(res.body.bots[0].id).toBe('bot-1');
  });

  // A healthy empty roster is byte-identical to what this route always sent —
  // the degraded marker appears only on a failure, which is what makes the two
  // tellable apart. See bots-roster-degraded.test.ts for the other half.
  it('serves an empty roster as an empty list', async () => {
    m(listBotsResult).mockResolvedValue({ items: [] });
    expect((await request(buildApp()).get('/api/bots')).body).toEqual({ bots: [] });
  });
});

describe('POST /api/bots', () => {
  it('requires a name, a known template, a prompt, a model and a known trigger', async () => {
    const app = buildApp();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...VALID_CREATE, name: '  ' }, /name is required/],
      [{ ...VALID_CREATE, template: 'saga' }, /template must be one of: epic, story, bug/],
      [{ ...VALID_CREATE, prompt: '  ' }, /a bot is a written mission/],
      [{ ...VALID_CREATE, model: '' }, /model is required/],
      [{ ...VALID_CREATE, trigger: 'whenever' }, /trigger must be one of: manual, cron, pr_watch/],
    ];
    for (const [body, pattern] of cases) {
      const res = await request(app).post('/api/bots').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(pattern);
    }
    expect(createBot).not.toHaveBeenCalled();
  });

  it('enforces the trigger→target shape a cron or pr_watch bot needs', async () => {
    const app = buildApp();
    m(validateCronExpr).mockReturnValue(false);
    const badCron = await request(app).post('/api/bots')
      .send({ ...VALID_CREATE, trigger: 'cron', cronExpr: 'sometimes' });
    expect(badCron.status).toBe(400);
    expect(badCron.body.error).toMatch(/a cron bot requires a valid cronExpr/);

    const noRepo = await request(app).post('/api/bots').send({ ...VALID_CREATE, trigger: 'pr_watch' });
    expect(noRepo.status).toBe(400);
    expect(noRepo.body.error).toMatch(/watches a repository/);

    const bothTargets = await request(app).post('/api/bots')
      .send({ ...VALID_CREATE, agentProjectId: UUID, orgProjectId: 'p-obs' });
    expect(bothTargets.status).toBe(400);
    expect(bothTargets.body.error).toMatch(/not both/);
    expect(createBot).not.toHaveBeenCalled();
  });

  it('rejects the field shapes that would otherwise 500 inside Aurora', async () => {
    const app = buildApp();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ agentProjectId: 'not-a-uuid' }, /codebase UUID/],
      [{ orgProjectId: '   ' }, /non-empty project id/],
      [{ budgetPerRunUsd: '5' }, /budgetPerRunUsd must be a non-negative number/],
      [{ budgetPerDayUsd: -1 }, /budgetPerDayUsd must be a non-negative number/],
      [{ maxRunsPerDay: 1.5 }, /maxRunsPerDay must be an integer >= 0/],
      [{ maxRunsPerDay: -2 }, /maxRunsPerDay must be an integer >= 0/],
    ];
    for (const [extra, pattern] of cases) {
      const res = await request(app).post('/api/bots').send({ ...VALID_CREATE, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(pattern);
    }
    expect(createBot).not.toHaveBeenCalled();
  });

  it('creates a trimmed bot, attributes it, and ARMS it with the live scheduler', async () => {
    m(createBot).mockResolvedValue(BOT);
    const res = await request(buildApp()).post('/api/bots').send(VALID_CREATE);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['bot']);
    expect(m(createBot).mock.calls[0]![0]).toMatchObject({
      name: 'Nightly lint', prompt: 'fix lint', model: 'amazon.nova-pro-v1:0',
      template: 'bug', trigger: 'manual', createdBy: 'u-nora',
      cronExpr: null, agentProjectId: null, orgProjectId: null,
      budgetPerRunUsd: null, budgetPerDayUsd: null,
    });
    // Registered with the running scheduler, not just written to the database.
    expect(registerBot).toHaveBeenCalledWith(BOT);
  });

  it('omits optional flags entirely when they were not supplied', async () => {
    m(createBot).mockResolvedValue(BOT);
    await request(buildApp()).post('/api/bots').send(VALID_CREATE);
    const arg = m(createBot).mock.calls[0]![0] as Record<string, unknown>;
    for (const key of ['enabled', 'maxRunsPerDay', 'requiresReview']) {
      expect(Object.prototype.hasOwnProperty.call(arg, key)).toBe(false);
    }
  });

  it('503s — not 500 — and arms nothing when Aurora is absent', async () => {
    m(createBot).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/bots').send(VALID_CREATE);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/bots require Aurora/);
    expect(registerBot).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/bots/:id', () => {
  it('404s an unknown bot before validating anything', async () => {
    m(getBot).mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/bots/bot-x').send({ name: '' });
    expect(res.status).toBe(404);
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('validates the shape the bot WILL have, not the patch alone', async () => {
    // Switching trigger to cron must fail without a cron expression even when
    // the patch carries neither field.
    m(getBot).mockResolvedValue({ ...BOT, trigger: 'manual', cronExpr: null });
    const res = await request(buildApp()).patch('/api/bots/bot-1').send({ trigger: 'cron' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/a cron bot requires a valid cronExpr/);
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('accepts a trigger switch when the EXISTING row already satisfies it', async () => {
    m(getBot).mockResolvedValue({ ...BOT, cronExpr: '0 3 * * *' });
    m(updateBot).mockResolvedValue({ ...BOT, trigger: 'cron', cronExpr: '0 3 * * *' });
    const res = await request(buildApp()).patch('/api/bots/bot-1').send({ trigger: 'cron' });
    expect(res.status).toBe(200);
    expect(m(updateBot).mock.calls[0]![1]).toEqual({ trigger: 'cron' });
  });

  it('refuses a blank name, prompt or model rather than storing an empty mission', async () => {
    m(getBot).mockResolvedValue(BOT);
    const app = buildApp();
    for (const body of [{ name: '  ' }, { prompt: '  ' }, { model: '  ' }]) {
      const res = await request(app).patch('/api/bots/bot-1').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cannot be empty/);
    }
    expect(updateBot).not.toHaveBeenCalled();
  });

  it('applies the same field-shape checks as create', async () => {
    m(getBot).mockResolvedValue(BOT);
    const res = await request(buildApp()).patch('/api/bots/bot-1')
      .send({ budgetPerRunUsd: 'lots' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative number/);
  });

  it('patches only the keys present, and RE-ARMS the scheduler with the new shape', async () => {
    m(getBot).mockResolvedValue(BOT);
    const updated = { ...BOT, enabled: false, budgetPerRunUsd: 2 };
    m(updateBot).mockResolvedValue(updated);
    const res = await request(buildApp()).patch('/api/bots/bot-1')
      .send({ enabled: false, budgetPerRunUsd: 2 });
    expect(res.status).toBe(200);
    expect(m(updateBot).mock.calls[0]![1]).toEqual({ enabled: false, budgetPerRunUsd: 2 });
    // registerBot re-schedules or clears as the new shape dictates.
    expect(registerBot).toHaveBeenCalledWith(updated);
  });

  it('404s when the update itself found nothing to change', async () => {
    m(getBot).mockResolvedValue(BOT);
    m(updateBot).mockResolvedValue(null);
    const res = await request(buildApp()).patch('/api/bots/bot-1').send({ enabled: true });
    expect(res.status).toBe(404);
    expect(registerBot).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/bots/:id', () => {
  it('deletes and DISARMS the live cron; 404s a bot that was not there', async () => {
    m(deleteBot).mockResolvedValue(true);
    const ok = await request(buildApp()).delete('/api/bots/bot-1');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(unregisterBot).toHaveBeenCalledWith('bot-1');

    jest.clearAllMocks();
    m(deleteBot).mockResolvedValue(false);
    const missing = await request(buildApp()).delete('/api/bots/bot-x');
    expect(missing.status).toBe(404);
    // A delete that did nothing must not disarm anything either.
    expect(unregisterBot).not.toHaveBeenCalled();
  });
});

describe('POST /api/bots/:id/run', () => {
  it('fires with 202 ACCEPTED and records WHO fired it', async () => {
    m(getBot).mockResolvedValue(BOT);
    m(fireBot).mockResolvedValue({ ok: true, run: { id: 'run-1', status: 'running' } });
    const res = await request(buildApp()).post('/api/bots/bot-1/run')
      .send({ instruction: '  focus on the flaky test  ' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ run: { id: 'run-1', status: 'running' } });
    // Attribution is what lets a sprint envelope be burned down against a
    // person at all; a cron firing has none.
    expect(m(fireBot).mock.calls[0]![1]).toEqual({
      trigger: 'manual', instruction: 'focus on the flaky test', dispatchedBy: 'u-nora',
    });
  });

  it('records a NULL dispatcher for an unauthenticated firing rather than inventing one', async () => {
    m(getBot).mockResolvedValue(BOT);
    m(fireBot).mockResolvedValue({ ok: true, run: {} });
    await request(buildApp(null)).post('/api/bots/bot-1/run').send({});
    expect((m(fireBot).mock.calls[0]![1] as { dispatchedBy: string | null }).dispatchedBy).toBeNull();
  });

  it('skips the budget gate entirely for a bot with no per-run budget', async () => {
    m(getBot).mockResolvedValue({ ...BOT, budgetPerRunUsd: null });
    m(fireBot).mockResolvedValue({ ok: true, run: {} });
    await request(buildApp()).post('/api/bots/bot-1/run').send({});
    expect(decideRunBudget).not.toHaveBeenCalled();
  });

  it('409s over the per-run budget with the ESTIMATE attached and the flag NAMED', async () => {
    m(getBot).mockResolvedValue({ ...BOT, budgetPerRunUsd: 0.5 });
    m(decideRunBudget).mockReturnValue({ kind: 'confirm', reason: 'estimated $1.20 exceeds the $0.50 per-run budget' });
    const res = await request(buildApp()).post('/api/bots/bot-1/run').send({});
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('run-budget');
    // The same word dispatch-work uses — one gate, one flag.
    expect(res.body.confirmFlag).toBe('confirmOverRunBudget');
    expect(res.body.runBudget).toEqual({ budgetPerRunUsd: 0.5, costUsdP25: 0.4, costUsdP75: 1.2 });
    expect(res.body.estimate).toBeDefined();
    expect(fireBot).not.toHaveBeenCalled();
    // The brake judges the P75 against the budget, not the midpoint.
    expect(m(decideRunBudget).mock.calls[0]!.slice(0, 2)).toEqual([0.5, 1.2]);
  });

  it('fires once the operator confirms over the run budget', async () => {
    m(getBot).mockResolvedValue({ ...BOT, budgetPerRunUsd: 0.5 });
    m(decideRunBudget).mockReturnValue({ kind: 'allow' });
    m(fireBot).mockResolvedValue({ ok: true, run: { id: 'run-2' } });
    const res = await request(buildApp()).post('/api/bots/bot-1/run')
      .send({ confirmOverRunBudget: true });
    expect(res.status).toBe(202);
    expect(m(decideRunBudget).mock.calls[0]![2]).toBe(true);
  });

  it('relays a refusal from the runner as a 409 with its reason', async () => {
    m(getBot).mockResolvedValue(BOT);
    m(fireBot).mockResolvedValue({ ok: false, reason: 'bot is paused' });
    const res = await request(buildApp()).post('/api/bots/bot-1/run').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'bot is paused' });
  });
});

describe('GET /api/bots/:id/runs', () => {
  it('wraps the firing history for THAT bot, bounded', async () => {
    m(listBotRunsResult).mockResolvedValue({ items: [{ id: 'run-1', status: 'succeeded' }] });
    const res = await request(buildApp()).get('/api/bots/bot-1/runs');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['runs']);
    expect(listBotRunsResult).toHaveBeenCalledWith('bot-1', 50);
  });

  it('returns an empty history for a bot that has never fired', async () => {
    m(listBotRunsResult).mockResolvedValue({ items: [] });
    expect((await request(buildApp()).get('/api/bots/bot-9/runs')).body).toEqual({ runs: [] });
  });
});

// GET /api/bots/runs?botIds=a,b,c — the bulk read InitiativeAgentRail uses
// instead of one `/:id/runs` request per bot targeting an initiative.
// Registered ahead of `/:id` in routes/bots.ts on purpose: these tests would
// fail with "runs" read back as a bot id if that ordering ever regressed.
describe('GET /api/bots/runs', () => {
  it('parses the comma-separated ids and wraps the merged history', async () => {
    m(listBotRunsForBotsResult).mockResolvedValue({ items: [{ id: 'run-1' }, { id: 'run-2' }] });
    const res = await request(buildApp()).get('/api/bots/runs?botIds=bot-1,bot-2');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['runs']);
    expect(res.body.runs).toHaveLength(2);
    expect(listBotRunsForBotsResult).toHaveBeenCalledWith(['bot-1', 'bot-2'], 50);
  });

  it('answers an empty list without calling the provider when no ids are given', async () => {
    const res = await request(buildApp()).get('/api/bots/runs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: [] });
    expect(listBotRunsForBotsResult).not.toHaveBeenCalled();
  });

  it('carries the degraded marker through when the provider could not read', async () => {
    m(listBotRunsForBotsResult).mockResolvedValue({ items: [], degraded: true, error: 'bots schema not applied' });
    const res = await request(buildApp()).get('/api/bots/runs?botIds=bot-1');
    expect(res.body.degraded).toBe(true);
    expect(res.body.error).toBe('bots schema not applied');
  });

  it('is registered ahead of /:id — "runs" never reads back as a bot id', async () => {
    m(listBotRunsForBotsResult).mockResolvedValue({ items: [] });
    m(getBot).mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/bots/runs?botIds=bot-1');
    expect(res.status).toBe(200);
    expect(getBot).not.toHaveBeenCalled();
  });
});
