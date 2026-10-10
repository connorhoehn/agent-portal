// The Computer Lab demo director (mock/demo-director.ts), told end to end at
// zero pace against real routers over real HTTP.
//
// What is real here: the bots router's whole dispatch-work gate chain (grant
// scope, preflight, forecast, the three money brakes, the concurrency ceiling),
// lib/bot-runner's governed dispatch and ensureWorkspace, lib/sdlc-pipeline's
// capture → review → gate, the devbox router's rename and task routes, the
// fleet registry, the reconcile arm, and the fake microVM (mock/devbox-shell.ts)
// playing the demo's work products. What is stood in: config (import.meta),
// Cedar (authz), the session cookie (a header the test app turns into Nora's
// session), and the schedulers this story does not exercise.

const mockConfig = { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../lib/devbox-arn.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDevboxClient } = require('../devbox-shell.js') as typeof import('../devbox-shell.js');
  const client = mockDevboxClient();
  return {
    resolveDevboxArn: jest.fn(async () => 'arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/orgiq_devbox-MOCK'),
    devboxDataClient: jest.fn(() => client),
  };
});
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));
jest.mock('../../lib/job-dispatcher.js', () => ({
  dispatcherEvents: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
  dispatchOnce: jest.fn(),
  busyBoxes: jest.fn(() => []),
}));
jest.mock('../../lib/work-suggestions.js', () => ({ suggestWork: jest.fn(async () => []) }));

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { botsRouter } from '../../routes/bots.js';
import { devboxRouter } from '../../routes/devbox.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry } from '../core/index.js';
import { devboxBoxes } from '../devbox-fleet.js';
import { sdlcChanges } from '../sdlc.js';
import { workItems } from '../work-items.js';
import { DEMO_ENVELOPE_USD } from '../budgets.js';
import { resetMockDevboxTransport } from '../devbox-shell.js';
import { _resetFleet, hydrateBoxes, getBox, replayEvents, isReserved, type FleetEvent } from '../../lib/devbox-fleet.js';
import {
  startDemoDirector, stopDemoDirector, resetDemoDirector, getDemoState, DEMO_NEXT_ITEM,
} from '../demo-director.js';
import { demoActive } from '../demo-pace.js';

process.env['MOCK_AGENTCORE'] = 'true';
// A short beat rather than none: at zero, A's run finishes before B is picked
// up, so B rightly REUSES A's idle workspace (lib/bot-runner.ts ensureWorkspace)
// and the story has two computers, not three. Overlapping runs are the story.
process.env['DEMO_DIRECTOR_PACE_MS'] = '20';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // The session cookie, stood in: login sets a marker the next requests carry,
  // and only a request carrying it is Nora — so the director genuinely has to
  // sign in before anything it does is attributed to her.
  app.post('/api/session/login', (req, res) => {
    const userId = (req.body as { userId?: string }).userId;
    // The real login's shape: clear any old cookie, THEN set the new one —
    // the same name twice, which a naive jar gets wrong.
    res.setHeader('set-cookie', [
      'demo-session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      `demo-session=${userId}; Path=/; HttpOnly`,
    ]);
    res.json({ sub: userId });
  });
  app.use((req, _res, next) => {
    if (/^demo-session=u-nora$/.test(req.headers.cookie ?? '')) {
      (req as unknown as { session: unknown }).session = {
        sub: 'u-nora', role: 'sme', tenant: 'orgiq', grants: { orgiq: ['sme'] },
      };
    }
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use('/api/devbox', devboxRouter);
  app.use(errorHandler);
  return app;
}

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(buildApp());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  resetDemoDirector();
  resetMockDevboxTransport();
  fixtureRegistry.resetAll('default');
  _resetFleet();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  resetDemoDirector();
  resetMockDevboxTransport();
  fixtureRegistry.resetAll('demo');
  _resetFleet();
  hydrateBoxes(devboxBoxes.rows().map((b) => ({ ...b })));
});

const typesOf = (boxId: string | null): unknown[] => (boxId ? replayEvents(boxId).map((e) => e['type']) : []);

describe('the demo director', () => {
  it('tells the whole story through the governed pipeline', async () => {
    await startDemoDirector(base);
    const state = getDemoState();

    expect(state.errors).toEqual([]);
    expect(state.phase).toBe('done');
    expect(state.milestones).toEqual({
      running3: true, questionAsked: true, questionAnswered: true,
      captured: true, answerCaptured: true, gateRefused: true,
    });
    expect(state.answeredBy).toBe('director');
    expect(demoActive()).toBe(false);

    const [a, b, c] = state.agents;

    // Three computers, minted by the dispatches themselves, named for their agents.
    const boxes = state.agents.map((x) => getBox(x.boxId!)!);
    expect(new Set(boxes.map((x) => x.id)).size).toBe(3);
    for (const box of boxes) {
      expect(box.projectId).toBe('p-auth-migration');
      expect(box.ownerId).toBe('u-nora');
    }
    expect(a!.label).toMatch(/^Ada · auth-migration-\d$/);

    // Each run carried its plan in the real TodoWrite shape.
    for (const x of state.agents) {
      const plan = replayEvents(x.boxId!).find((e) =>
        (e as { message?: { content?: Array<{ name?: string }> } }).message?.content?.[0]?.name === 'TodoWrite');
      expect(plan).toBeDefined();
    }

    // A: captured for review, the frame in its tail naming the commit.
    const aDelivery = replayEvents(a!.boxId!).find((e) => e['type'] === 'delivery') as FleetEvent;
    expect(aDelivery).toMatchObject({ workItemId: a!.workItemId, title: expect.any(String) as string });
    expect(String(aDelivery['commitSha'])).toMatch(/^[0-9a-f]{40}$/);
    const queued = sdlcChanges.rows().filter((ch) => ch.workItemId === a!.workItemId);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(aDelivery['captureId']);

    // B: asked, waited, was answered on its own session, and was captured.
    const bTypes = typesOf(b!.boxId);
    expect(bTypes.filter((t) => t === 'task_started')).toHaveLength(2);
    expect(bTypes).toContain('result');
    expect(bTypes).toContain('delivery');
    expect(sdlcChanges.rows().some((ch) => ch.workItemId === b!.workItemId)).toBe(true);

    // C: its next pickup held at the envelope gate, the 409 body verbatim.
    expect(state.gate).toMatchObject({ gate: 'envelope', confirmFlag: 'confirmOverEnvelope' });
    const refused = replayEvents(c!.boxId!).find((e) => e['type'] === 'gate_refused') as FleetEvent;
    expect(refused).toMatchObject({
      status: 409, gate: 'envelope', confirmFlag: 'confirmOverEnvelope',
      error: state.gate!['error'], workItemId: DEMO_NEXT_ITEM,
    });
    expect((refused['envelope'] as { allocatedUsd: number }).allocatedUsd).toBe(DEMO_ENVELOPE_USD);
    // Nothing was claimed by the refused pickup.
    expect(workItems.rows().find((w) => w.id === DEMO_NEXT_ITEM)!.status).toBe('open');
    // The two settled items moved on the board the way reconcile moves them.
    expect(workItems.rows().find((w) => w.id === a!.workItemId)!.status).toBe('in_review');
    expect(workItems.rows().find((w) => w.id === c!.workItemId)!.status).toBe('in_review');
  }, 60_000);

  it('holds its computers for the whole story, and a person\'s answer is what resumes Basil', async () => {
    const story = startDemoDirector(base, { autoAnswer: false });
    // Wait for Basil's question, then check nobody else may claim the three.
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
      expect(ok()).toBe(true);
    };
    await until(() => getDemoState().milestones.questionAsked && getDemoState().milestones.gateRefused);
    const [a, b, c] = getDemoState().agents;
    for (const x of [a!, b!, c!]) expect(isReserved(x.boxId!)).toBe(true);
    expect(getDemoState().milestones.questionAnswered).toBe(false);   // nobody has answered

    // Nora answers through the lab's reply route — the same one Nudge uses.
    const login = await fetch(`${base}/api/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-nora' }),
    });
    const cookie = login.headers.getSetCookie().map((x) => x.split(';')[0]).filter((x) => !x!.endsWith('=')).join('; ');
    const reply = await fetch(`${base}/api/devbox/${encodeURIComponent(b!.sessionId!)}/task`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'Smallest tenant first.', resume: true }),
    });
    await reply.text();
    expect(reply.status).toBe(200);

    await story;
    const state = getDemoState();
    expect(state.phase).toBe('done');
    expect(state.answeredBy).toBe('person');
    expect(state.milestones.answerCaptured).toBe(true);
    stopDemoDirector();
    for (const x of [a!, b!, c!]) expect(isReserved(x.boxId!)).toBe(false);
  }, 60_000);

  it('can be stopped, and a stopped story says so', async () => {
    const story = startDemoDirector(base);
    stopDemoDirector();
    await story;
    expect(getDemoState().phase).toBe('stopped');
    expect(demoActive()).toBe(false);
  });

  it('reports an idle director before anything starts', () => {
    expect(getDemoState()).toMatchObject({ phase: 'idle', milestones: { running3: false, gateRefused: false } });
  });
});
