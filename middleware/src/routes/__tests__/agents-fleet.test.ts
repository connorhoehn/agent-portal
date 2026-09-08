// The agent fleet reads — GET /api/agents and GET /api/agents/:id/metrics
// (routes/agents.ts). Everything the Agents page renders before anyone
// invokes anything. (The invoke gate has its own suite,
// agents-invoke-capability.test.ts.)
//
// What is pinned:
//   * the AUTH FLOOR: both reads carry `requireTenant('orgiq')` and NO
//     capability gate. An agent runtime's health is operational visibility
//     every orgiq role has; adding a capability here would blank the fleet
//     page for the roles that use it most,
//   * the wire shape the fleet cards read — id, name, status, protocol, model,
//     tools, guardrails, endpoint and both latency percentiles. These are
//     rendered field-by-field, so a rename is invisible until a card goes
//     blank,
//   * that a fleet with nothing deployed is an EMPTY LIST, not an error — the
//     state a fresh account is genuinely in,
//   * 404 for metrics on an agent that is not deployed, so the page can say
//     "not deployed" rather than drawing a chart of zeroes.

const tenantGates: string[] = [];
const actionGates: string[] = [];

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
    cognito: {
      userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '',
      postLoginUrl: '/', logoutRedirectUrl: '/',
    },
  },
}));
jest.mock('aws-jwt-verify', () => ({
  CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) },
}));
jest.mock('../../lib/authz.js', () => ({
  requireTenant: (tenant: string) => {
    tenantGates.push(tenant);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  requireAction: (action: string) => {
    actionGates.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  isAllowed: jest.fn(async () => true),
  resolveSession: () => null,
}));
jest.mock('@connorhoehnslalom/realtime-modules/agent-streaming', () => ({
  agentStreamMiddleware: () => (_req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ streamed: true }),
}));
jest.mock('../../providers/index.js', () => ({
  agentcore: {
    listRuntimes: jest.fn(), getRuntimeMetrics: jest.fn(), invokeAgentStreaming: jest.fn(),
  },
  aurora: { fetchGraph: jest.fn(async () => ({ nodes: [] })) },
}));
jest.mock('../../providers/memory.js', () => ({ listEvents: jest.fn(), recordTurn: jest.fn() }));
jest.mock('../../lib/invocations.js', () => ({
  detectIntervention: jest.fn(), recordInvocation: jest.fn(), snippet: (s: string) => s,
}));
jest.mock('../../lib/session-titles.js', () => ({ maybeGenerateTitle: jest.fn() }));
jest.mock('../../lib/answer-sources.js', () => ({ annotateToolResult: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { agentcore } from '../../providers/index.js';

const ac = agentcore as unknown as Record<string, jest.Mock>;

const RUNTIME = {
  id: 'orgiq-supervisor', name: 'Supervisor', status: 'healthy', protocol: 'ag-ui',
  model: 'amazon.nova-pro-v1:0', tools: ['kb_query', 'graph_read'],
  guardrails: ['orgiq-guardrail'], endpoint: 'https://runtime.example/invocations',
  latencyP50Ms: 820, latencyP99Ms: 4100,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('auth floor', () => {
  it('gates both reads on the orgiq TENANT and on no capability', () => {
    // Runtime health is operational visibility every orgiq role has; a
    // capability gate here would blank the fleet page for the roles that live
    // on it. (The invoke route's own gates are covered elsewhere.)
    expect(tenantGates.filter((t) => t === 'orgiq').length).toBeGreaterThanOrEqual(2);
    expect(actionGates).not.toContain('ViewObservability');
  });
});

describe('GET /api/agents', () => {
  it('ships every field a fleet card renders', async () => {
    ac['listRuntimes']!.mockResolvedValue([RUNTIME]);
    const res = await request(buildApp()).get('/api/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'endpoint', 'guardrails', 'id', 'latencyP50Ms', 'latencyP99Ms',
      'model', 'name', 'protocol', 'status', 'tools',
    ]);
    expect(res.body[0].tools).toEqual(['kb_query', 'graph_read']);
    // p50 <= p99 or the latency pair is telling the card a nonsense story.
    expect(res.body[0].latencyP50Ms).toBeLessThanOrEqual(res.body[0].latencyP99Ms);
  });

  it('answers a bare ARRAY, and an empty one when nothing is deployed', async () => {
    // The state a fresh account is genuinely in — not an error.
    ac['listRuntimes']!.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/agents');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /api/agents/:agentId/metrics', () => {
  it('returns the metrics for the NAMED agent', async () => {
    ac['getRuntimeMetrics']!.mockResolvedValue({
      agentId: 'orgiq-supervisor', invocations: 42, errorRate: 0.02, p50Ms: 820, p99Ms: 4100,
    });
    const res = await request(buildApp()).get('/api/agents/orgiq-supervisor/metrics');
    expect(res.status).toBe(200);
    expect(ac['getRuntimeMetrics']).toHaveBeenCalledWith('orgiq-supervisor');
    expect(res.body.invocations).toBe(42);
  });

  it('404s an agent that is not deployed, so the page says so instead of drawing zeroes', async () => {
    ac['getRuntimeMetrics']!.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/agents/orgiq-nope/metrics');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Agent not found' });
  });
});
