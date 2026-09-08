// Access-control gate on POST /api/agents/:agentId/invoke (audit finding B1).
//
// Search + tenant is enough to invoke a READ agent, but the write/pipeline
// agents (graph-builder, ingestion, scoring) mutate durable state and, invoked
// DIRECTLY, bypass the supervisor's role guardrail — so they additionally
// require the ManageIngest capability. These tests pin:
//   * a Search-only (member) session 403s on graph-builder / ingestion /
//     scoring but succeeds on supervisor / search,
//   * a ManageIngest holder succeeds on the write agents,
//   * id spellings (orgiq-graph-builder, orgiq_graph_builder) all gate.
//
// The gate is middleware that runs BEFORE the SSE stream opens, so the streamed
// handler is never reached in the 403 path. For the ALLOW path the streaming
// middleware is mocked to a plain 200 so no real agent is invoked.
//
// config.ts uses import.meta and aws-jwt-verify is ESM — both mocked so the CJS
// test build can load (same pattern as session-capabilities.test.ts).

const mockSend = jest.fn();

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    // policyStoreId non-empty so evaluate() actually calls AVP (mocked below).
    auth: { sessionSigningSecretArn: '', policyStoreId: 'ps-test' },
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
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class {
    send(cmd: unknown) { return mockSend(cmd); }
  },
  IsAuthorizedCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

// The streaming middleware is replaced by a terminal handler that just 200s —
// reaching it means every gate passed, and no real agent runtime is touched.
jest.mock('@connorhoehnslalom/realtime-modules/agent-streaming', () => ({
  agentStreamMiddleware: () => (req: unknown, res: { json: (b: unknown) => void }) =>
    res.json({ streamed: true }),
}));

// Providers are imported at module load; stub them so nothing hits AWS.
jest.mock('../../providers/index.js', () => ({
  agentcore: {
    listRuntimes: jest.fn(async () => []),
    invokeAgentStreaming: jest.fn(),
    getRuntimeMetrics: jest.fn(async () => null),
  },
  aurora: { fetchGraph: jest.fn(async () => ({ nodes: [] })) },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { agentsRouter } from '../agents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { clearAuthzCache } from '../../lib/authz.js';

/** The actionId a mocked IsAuthorizedCommand asks about. */
function actionIdOf(cmd: unknown): string {
  return (cmd as { input: { action: { actionId: string } } }).input.action.actionId;
}

/** AVP grants only the listed actions; everything else DENYs. */
function allowOnly(...actions: string[]) {
  const set = new Set(actions);
  mockSend.mockImplementation((cmd: unknown) =>
    Promise.resolve({ decision: set.has(actionIdOf(cmd)) ? 'ALLOW' : 'DENY' }));
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  app.use(errorHandler);
  return app;
}

function invoke(agentId: string) {
  return request(buildApp())
    .post(`/api/agents/${agentId}/invoke`)
    .send({ message: 'hi' });
}

beforeEach(() => {
  mockSend.mockReset();
  clearAuthzCache();
});

const WRITE_AGENTS = ['orgiq-graph-builder', 'orgiq-ingestion', 'orgiq-scoring'];
const READ_AGENTS = ['orgiq-supervisor', 'orgiq-search', 'orgiq-advisor'];

describe('POST /api/agents/:agentId/invoke — ManageIngest gate on write agents', () => {
  it('403s a Search-only (member) session on every write agent', async () => {
    allowOnly('Search'); // holds Search, NOT ManageIngest
    for (const id of WRITE_AGENTS) {
      const res = await invoke(id);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'Forbidden', action: 'ManageIngest', agentId: id });
      expect(res.body.message).toMatch(/data writes/i);
      expect(res.body.message).toMatch(/ManageIngest/);
    }
  });

  it('lets a Search-only session invoke the read agents', async () => {
    allowOnly('Search');
    for (const id of READ_AGENTS) {
      const res = await invoke(id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ streamed: true });
    }
  });

  it('lets a ManageIngest holder invoke every write agent', async () => {
    allowOnly('Search', 'ManageIngest');
    for (const id of WRITE_AGENTS) {
      const res = await invoke(id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ streamed: true });
    }
  });

  it('gates the alternate id spellings the runtime cache registers', async () => {
    allowOnly('Search');
    for (const id of ['graph-builder', 'orgiq_graph_builder', 'orgiq-ingestion']) {
      const res = await invoke(id);
      expect(res.status).toBe(403);
      expect(res.body.action).toBe('ManageIngest');
    }
  });

  it('still enforces Search first — no Search, no invoke even for a read agent', async () => {
    allowOnly(); // holds nothing
    const res = await invoke('orgiq-supervisor');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', action: 'Search' });
  });
});
