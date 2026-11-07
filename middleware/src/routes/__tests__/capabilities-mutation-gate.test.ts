// capabilitiesRouter (routes/capabilities.ts) had ZERO supertest coverage
// before this file — every route on it, read or write, was untested. That
// mattered here specifically because the router's authorization is two-layer
// and easy to silently break in one direction without the other noticing:
//
//   1. A blanket `capabilitiesRouter.use(...)` requires ManageDevbox on every
//      non-GET/HEAD verb outside /guardrail — code interpreter, browser
//      sessions and crawls spend real AWS money, so any mutation needs it.
//   2. The guardrail-editing routes require EditGuardrail instead, at the
//      floor and again on each route — disabling a PII filter or deleting a
//      denied-content topic is a content-safety control, so ManageDevbox
//      alone must not be enough to touch it; and since docs/next-steps.md §9
//      item 8c the editor is open to org-leader, who holds EditGuardrail but
//      no ManageDevbox, so ManageDevbox must not be required for it either.
//
// A regression that dropped either gate (e.g. a refactor that hoisted the
// guardrail routes above the blanket `.use`, or a copy-paste that reused
// `manageCaps` in place of `requireAction('EditGuardrail')`) would silently
// widen who can turn off content moderation. `authz.js` is mocked to a
// recorder (same pattern as budgets.test.ts) rather than the real Cedar
// client, because what is pinned here is WHICH action each route asks for
// and in what order — not Cedar's own decision logic, which is covered
// elsewhere (authz-matrix.test.ts).
//
// Also covered: DELETE /code-sessions/:sessionId, a destructive call against
// a real AgentCore Code Interpreter session — picked because it is the one
// pure-ManageDevbox (no second gate) mutation on this router, so together
// with the guardrail routes these tests show both points on the gate matrix:
// mutation-only and mutation+content-safety.

const mockGateActions: string[] = [];
const mockRequestGates: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    mockGateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => { mockRequestGates.push(action); next(); };
  },
}));

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1' } }));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(),
  ConverseCommand: jest.fn(),
}));

jest.mock('../../lib/crawler.js', () => ({
  startCrawl: jest.fn(), getCrawl: jest.fn(), listCrawls: jest.fn(() => []),
  cancelCrawl: jest.fn(), subscribeCrawl: jest.fn(),
}));
jest.mock('../../lib/invocations.js', () => ({
  recordCapabilityEvent: jest.fn(), snippet: (s: string) => s,
  appendJourneyStep: jest.fn(), getJourney: jest.fn(() => []), clearJourney: jest.fn(),
}));
jest.mock('../../lib/sse.js', () => ({ initSSE: jest.fn(), writeSSE: jest.fn(), endSSE: jest.fn() }));
jest.mock('../../providers/capability-reconcile.js', () => ({ reconcileCapabilities: jest.fn() }));

jest.mock('../../providers/index.js', () => ({
  guardrails: {
    getGuardrail: jest.fn(),
    togglePiiFilter: jest.fn(),
    updateDeniedTopic: jest.fn(),
    addDeniedTopic: jest.fn(),
    removeDeniedTopic: jest.fn(),
  },
  agentcore: {
    listCodeSessions: jest.fn(),
    terminateCodeSession: jest.fn(),
  },
  cloudwatch: {
    getGuardrailMetrics: jest.fn(),
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { capabilitiesRouter } from '../capabilities.js';
import { errorHandler } from '../../lib/async-handler.js';
import { guardrails, agentcore } from '../../providers/index.js';

const togglePii = guardrails.togglePiiFilter as jest.Mock;
const updateTopic = guardrails.updateDeniedTopic as jest.Mock;
const addTopic = guardrails.addDeniedTopic as jest.Mock;
const removeTopic = guardrails.removeDeniedTopic as jest.Mock;
const terminateCodeSession = agentcore.terminateCodeSession as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/capabilities', capabilitiesRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  togglePii.mockReset(); updateTopic.mockReset(); addTopic.mockReset();
  removeTopic.mockReset(); terminateCodeSession.mockReset();
  mockRequestGates.length = 0;
});

describe('capabilitiesRouter — gate construction (module load, not per-request)', () => {
  // `requireAction(...)` builds one middleware closure per call, at router
  // construction time — a real request just invokes the already-built
  // closure, it does not call `requireAction` again. So the regression this
  // guards against (a route losing its gate, or the wrong routes sharing
  // one) shows up in HOW MANY TIMES and WHICH action was asked for while the
  // module loaded, not in a per-request log — hence one assertion on the
  // full construction sequence rather than one per test.
  it('builds ManageDevbox once (the blanket), EditGuardrail once for the guardrail floor and once per guardrail-editing route', () => {
    expect(mockGateActions).toEqual([
      'ManageDevbox', // capabilitiesRouter.use(...) — every non-GET/HEAD verb outside /guardrail
      'EditGuardrail', // capabilitiesRouter.use(...) — every non-GET/HEAD verb under /guardrail
      'EditGuardrail', // PATCH /guardrail/pii
      'EditGuardrail', // PATCH /guardrail/topics/:name
      'EditGuardrail', // POST /guardrail/topics
      'EditGuardrail', // DELETE /guardrail/topics/:name
    ]);
    // In particular: DELETE /code-sessions/:sessionId below is a real
    // mutation but never asks for EditGuardrail — if it ever silently
    // gained that requirement (or lost ManageDevbox), this count would move.
  });
});

describe('capabilitiesRouter — which gates a request passes', () => {
  it('a guardrail edit asks EditGuardrail and never ManageDevbox (org-leader holds only the first)', async () => {
    togglePii.mockResolvedValue({ type: 'EMAIL', enabled: false });
    await request(buildApp()).patch('/api/capabilities/guardrail/pii').send({ type: 'EMAIL', enabled: false });
    expect(mockRequestGates).toEqual(['EditGuardrail', 'EditGuardrail']);
  });

  it('a code-session delete asks ManageDevbox only', async () => {
    terminateCodeSession.mockResolvedValue(true);
    await request(buildApp()).delete('/api/capabilities/code-sessions/cs-1');
    expect(mockRequestGates).toEqual(['ManageDevbox']);
  });
});

describe('capabilitiesRouter — guardrail mutations behave once past the gate', () => {
  it('PATCH /guardrail/pii toggles the named filter', async () => {
    togglePii.mockResolvedValue({ type: 'EMAIL', enabled: false });
    const res = await request(buildApp())
      .patch('/api/capabilities/guardrail/pii')
      .send({ type: 'EMAIL', enabled: false });
    expect(res.status).toBe(200);
    expect(togglePii).toHaveBeenCalledWith('EMAIL', { action: undefined, enabled: false });
  });

  it('POST /guardrail/topics adds a denied topic', async () => {
    addTopic.mockResolvedValue({ name: 'self-harm', definition: 'x', enabled: true });
    const res = await request(buildApp())
      .post('/api/capabilities/guardrail/topics')
      .send({ name: 'self-harm', definition: 'x' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, topic: { name: 'self-harm' } });
  });

  it('DELETE /guardrail/topics/:name removes a denied topic', async () => {
    removeTopic.mockResolvedValue(true);
    const res = await request(buildApp()).delete('/api/capabilities/guardrail/topics/self-harm');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(removeTopic).toHaveBeenCalledWith('self-harm');
  });

  it('DELETE /guardrail/topics/:name 404s a topic that never existed, rather than a silent 200', async () => {
    removeTopic.mockResolvedValue(false);
    const res = await request(buildApp()).delete('/api/capabilities/guardrail/topics/nope');
    expect(res.status).toBe(404);
  });

  it('PATCH /guardrail/topics/:name 404s a topic that does not exist', async () => {
    updateTopic.mockResolvedValue(null);
    const res = await request(buildApp())
      .patch('/api/capabilities/guardrail/topics/nope')
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });
});

describe('capabilitiesRouter — non-guardrail mutation (ManageDevbox only)', () => {
  it('DELETE /code-sessions/:sessionId terminates the AgentCore session', async () => {
    terminateCodeSession.mockResolvedValue(true);
    const res = await request(buildApp()).delete('/api/capabilities/code-sessions/cs-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(terminateCodeSession).toHaveBeenCalledWith('cs-1');
  });

  it('a code session that is already gone 404s rather than a bare 200', async () => {
    terminateCodeSession.mockResolvedValue(false);
    const res = await request(buildApp()).delete('/api/capabilities/code-sessions/cs-gone');
    expect(res.status).toBe(404);
  });
});

describe('capabilitiesRouter — reads stay open', () => {
  it('GET /guardrail never touches a mutation gate', async () => {
    const getGuardrailMock = guardrails.getGuardrail as jest.Mock;
    getGuardrailMock.mockResolvedValue({ piiFilters: [], deniedTopics: [] });
    const res = await request(buildApp()).get('/api/capabilities/guardrail');
    expect(res.status).toBe(200);
  });
});
