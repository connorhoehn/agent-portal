// The other half of the provider-degradation work: the routes carry it.
//
// providers/__tests__/agentcore-listing-degraded.test.ts proves the providers
// can now tell "there is nothing here" from "we could not look". That is only
// worth having if it reaches the wire, and reaches it in the ONE spelling the
// rest of the tree uses — `degraded: true` plus the first line of the error,
// which routes/cost.ts established, routes/environments.ts copied, and
// routes/__tests__/swallowed-failure-scan.test.ts recognises.
//
// Each route is asserted in BOTH states, because either half alone is
// worthless: a route that always marked degraded would pass a shape check and
// mean nothing, and a healthy empty answer that changed shape would break the
// pages and the tests that already pin it. The healthy empty answer here is
// byte-identical to what these routes sent before this change.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    agentcore: { codeInterpreterId: '', browserId: '', browserProfileId: '', memoryId: '' },
    bedrock: {},
  },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: () => (_r: unknown, _s: unknown, n: () => void) => n(),
  requireSession: () => (_r: unknown, _s: unknown, n: () => void) => n(),
  requireTenant: () => (_r: unknown, _s: unknown, n: () => void) => n(),
  readForRolesElseAction: () => (_r: unknown, _s: unknown, n: () => void) => n(),
  isAllowed: jest.fn(async () => true),
  resolveSession: () => ({ sub: 'u-1', role: 'admin', tenant: 'orgiq' }),
}));
jest.mock('../../lib/audit.js', () => ({ logAuthz: jest.fn(), eventFromSession: jest.fn(() => ({})) }));
jest.mock('../../providers/index.js', () => ({
  agentcore: {
    listRuntimes: jest.fn(),
    listRuntimesResult: jest.fn(),
    getRuntime: jest.fn(),
    getRuntimeMetrics: jest.fn(),
    listCodeSessionsResult: jest.fn(),
    listBrowserSessionsResult: jest.fn(),
    terminateCodeSession: jest.fn(),
    executeCode: jest.fn(),
    createBrowserSession: jest.fn(),
    closeBrowserSession: jest.fn(),
    navigateBrowser: jest.fn(),
    screenshotBrowser: jest.fn(),
  },
  guardrails: {},
  cloudwatch: {},
  aurora: {},
}));
jest.mock('../../providers/capability-reconcile.js', () => ({ reconcileCapabilities: jest.fn() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { capabilitiesRouter } from '../capabilities.js';
import { agentDetailRouter } from '../agent-detail.js';
import { agentcore } from '../../providers/index.js';

const ac = agentcore as unknown as Record<string, jest.Mock>;

function app(mount: string, router: express.Router): express.Express {
  const a = express();
  a.use(express.json());
  a.use(mount, router);
  a.use(errorHandler);
  return a;
}

beforeEach(() => { for (const fn of Object.values(ac)) fn.mockReset(); });

describe('GET /api/capabilities/code-sessions', () => {
  const get = () => request(app('/api/capabilities', capabilitiesRouter)).get('/api/capabilities/code-sessions');

  it('no sandbox running: an empty list, and nothing else on the object', async () => {
    ac['listCodeSessionsResult']!.mockResolvedValue({ items: [] });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it('the data plane failed: the same empty list, saying so', async () => {
    ac['listCodeSessionsResult']!.mockResolvedValue({
      items: [], degraded: true,
      error: 'ListCodeInterpreterSessions failed: ResourceNotFoundException',
    });
    const res = await get();
    // Still a 200. A dead CODE_INTERPRETER_ID is an ordinary state of this
    // account; failing the whole Capabilities page over one panel is a worse
    // answer than showing the panel with its reason.
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.degraded).toBe(true);
    expect(res.body.error).toContain('ResourceNotFoundException');
  });

  it('a healthy read is unmarked even when it has rows', async () => {
    ac['listCodeSessionsResult']!.mockResolvedValue({ items: [{ sessionId: 'cs-1' }] });
    expect(Object.keys((await get()).body)).toEqual(['sessions']);
  });
});

describe('GET /api/capabilities/browser-sessions', () => {
  const get = () => request(app('/api/capabilities', capabilitiesRouter)).get('/api/capabilities/browser-sessions');

  it('no browser open: an empty list', async () => {
    ac['listBrowserSessionsResult']!.mockResolvedValue({ items: [] });
    expect((await get()).body).toEqual({ sessions: [] });
  });

  it('the browser is gone: the same empty list, saying so', async () => {
    // The documented SOFT failure — a BROWSER_ID left behind by a rebuilt
    // capabilities stack answers "Browser profile not found", and site-survey's
    // fallback cannot tell that from a site with no JavaScript-only pages.
    ac['listBrowserSessionsResult']!.mockResolvedValue({
      items: [], degraded: true, error: 'ListBrowserSessions failed: Browser profile not found',
    });
    const res = await get();
    expect(res.body.sessions).toEqual([]);
    expect(res.body.degraded).toBe(true);
  });
});

describe('GET /api/agent-detail/:agentId — the 404 that was a lie', () => {
  const get = (id: string) => request(app('/api/agent-detail', agentDetailRouter)).get(`/api/agent-detail/${id}`);

  it('still 404s when the fleet was READ and the agent is not in it', async () => {
    ac['listRuntimesResult']!.mockResolvedValue({ items: [] });
    const res = await get('orgiq-supervisor');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No agent runtime matching/);
  });

  it('503s, with the reason, when the fleet could not be read at all', async () => {
    ac['listRuntimesResult']!.mockResolvedValue({
      items: [], degraded: true, error: 'ListAgentRuntimes failed: AccessDeniedException',
    });
    const res = await get('orgiq-supervisor');
    expect(res.status).toBe(503);
    expect(res.body.degraded).toBe(true);
    expect(res.body.reason).toContain('AccessDeniedException');
    // And critically: it no longer asserts the agent does not exist.
    expect(JSON.stringify(res.body)).not.toMatch(/No agent runtime matching/);
  });

  it('never claims a missing agent when it never asked — the two differ by status AND body', async () => {
    ac['listRuntimesResult']!.mockResolvedValue({ items: [] });
    const quiet = await get('orgiq-supervisor');
    ac['listRuntimesResult']!.mockResolvedValue({ items: [], degraded: true, error: 'timed out' });
    const broken = await get('orgiq-supervisor');
    expect(quiet.status).not.toBe(broken.status);
    expect(quiet.body).not.toEqual(broken.body);
  });
});
