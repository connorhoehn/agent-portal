// GET /api/observability/pr-watch-health — the poller's health, made sayable.
//
// The gap this closes: `lib/pr-watch-poller.ts` has recorded its own health for
// a while (last tick, ok/not, failure streak, last error) and NOTHING exposed
// it, so the only way to learn that no PR had been dispatched for forty minutes
// was to tail the process logs. The poller is also quiet by design — it logs
// the first failure and then only every FAILURE_STREAK_ALERT-th one — so a
// reader arriving late finds nothing recent even while it is still broken.
//
// What is pinned here:
//   * the AUTH FLOOR. This is an observability READ: tenant scope +
//     ViewObservability, which is where every other operational aggregate on
//     this router sits. Deliberately NOT the bare `requireSession` floor:
//     poller health names repositories and carries upstream error text, so
//     "any signed-in user in any tenant" is the wrong tier — and deliberately
//     not anonymous, which is the trap `requireSession` exists for,
//   * that a process which has never ticked SAYS SO rather than answering a
//     zero that reads as healthy,
//   * that a failing poller reports the streak, the error AND `failingSince`,
//     which is the field that answers "for how long" without the reader having
//     to know the (tunable) poll interval,
//   * that a recovery clears the streak while KEEPING the last error, so a
//     fixed problem is distinguishable from a live one.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: false, agentcore: false, guardrails: false, cloudwatch: false },
    auth: { policyStoreId: undefined },
    cognito: {
      userPoolId: 'us-east-1_test', clientId: 'cid', clientSecret: 'csec',
      domain: 'example.auth', callbackUrl: 'http://localhost/cb',
    },
  },
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '',
      capabilities: ['ViewObservability'] },
    { id: 'no-obs', tenant: 'orgiq', label: 'No obs', summary: '', capabilities: [] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '',
      capabilities: ['ViewObservability'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

// The poller's tick is driven through the Data API, exactly as
// lib/__tests__/silent-fallback-degraded.test.ts drives it: a rejected `exec`
// is a tick that threw, a resolved one is a tick that completed.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../providers/connected-sources.js', () => ({ borrowApiKey: jest.fn() }));
jest.mock('../../providers/bots.js', () => ({ createBotRun: jest.fn() }));
jest.mock('../../lib/github-connector.js', () => ({ listPulls: jest.fn(), getPullStatus: jest.fn() }));
jest.mock('../../lib/bot-runner.js', () => ({ checkConcurrency: jest.fn(), botMaxConcurrent: () => 2 }));
jest.mock('../../providers/index.js', () => ({ cloudwatch: {} }));
jest.mock('../../lib/invocations.js', () => ({
  getRecentInvocations: () => [], getCapabilityEvents: () => [],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { observabilityRouter } from '../observability.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireAction, requireTenant } from '../../lib/authz.js';
import { runPollTick, resetPrWatchHealth } from '../../lib/pr-watch-poller.js';
import { exec } from '../../providers/aurora.js';

const PATH = '/api/observability/pr-watch-health';

type FakeSession = {
  sub: string; name: string; role: string; tenant: string;
  grants: Record<string, string[]>; iat: number;
};

function sessionFor(role: string, tenant: string): FakeSession {
  return { sub: `u-${role}`, name: role, role, tenant, grants: { [tenant]: [role] }, iat: 0 };
}

/** The mount index.ts uses: `viewObs` = tenant scope + ViewObservability. */
function buildApp(session: FakeSession | null) {
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      (req as unknown as { session: FakeSession }).session = session;
      next();
    });
  }
  app.use(
    '/api/observability',
    requireTenant('orgiq'),
    requireAction('ViewObservability'),
    observabilityRouter,
  );
  app.use(errorHandler);
  return app;
}

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  resetPrWatchHealth();
  execMock.mockReset();
  execMock.mockResolvedValue([]);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('auth floor', () => {
  it('is an OBSERVABILITY READ, not an anonymous one', async () => {
    // The trap requireSession exists for: a surface every role may look at is
    // not a surface anyone may look at.
    expect((await request(buildApp(null)).get(PATH)).status).toBe(401);
  });

  it('403s a session in the WRONG TENANT', async () => {
    // Poller health carries repository names and upstream error text; an
    // assessment-tenant session holding ViewObservability must not read it.
    const res = await request(buildApp(sessionFor('assessor', 'assessment'))).get(PATH);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ requiredTenant: 'orgiq' });
  });

  it('403s an orgiq role without ViewObservability', async () => {
    expect((await request(buildApp(sessionFor('no-obs', 'orgiq'))).get(PATH)).status).toBe(403);
  });

  it('lets ANY orgiq role that holds ViewObservability read it — it is an all-hands read within the tenant', async () => {
    expect((await request(buildApp(sessionFor('member', 'orgiq'))).get(PATH)).status).toBe(200);
  });
});

describe('what it says', () => {
  const app = () => buildApp(sessionFor('member', 'orgiq'));

  it('a process that has never ticked says so — it does not invent a healthy zero', async () => {
    const res = await request(app()).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      poller: 'pr-watch',
      running: false,
      lastTickAt: null,
      lastTickOk: null,   // null, not `true` — nothing has been observed yet
      consecutiveFailures: 0,
      failingSince: null,
    });
    expect(typeof res.body.checkedAt).toBe('string');
  });

  it('reports a completed tick with its counters', async () => {
    await runPollTick();
    const res = await request(app()).get(PATH);
    expect(res.body).toMatchObject({
      lastTickOk: true, consecutiveFailures: 0,
      dispatchedLastTick: 0, settledLastTick: 0, lastTickItemErrors: 0,
    });
    expect(typeof res.body.lastTickAt).toBe('string');
  });

  it('reports HOW LONG it has been failing, not just that it is', async () => {
    // The whole point: "failing for 40 minutes" has to be readable off the
    // wire. `consecutiveFailures` alone cannot say it — the interval is
    // tunable via BOT_PR_POLL_INTERVAL_MS and never appears in the response.
    execMock.mockRejectedValue(new Error('connect ECONNREFUSED aurora:5432\n  at exec'));
    const before = Date.now();
    await runPollTick();
    await runPollTick();
    await runPollTick();

    const res = await request(app()).get(PATH);
    expect(res.body).toMatchObject({ lastTickOk: false, consecutiveFailures: 3 });
    expect(res.body.lastError).toBe('connect ECONNREFUSED aurora:5432'); // first line only
    expect(new Date(res.body.failingSince).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The streak started at the FIRST failure, not the most recent one.
    expect(new Date(res.body.failingSince).getTime())
      .toBeLessThanOrEqual(new Date(res.body.lastErrorAt).getTime());
  });

  it('a recovery clears the streak but KEEPS the last error', async () => {
    // So a reader can tell a problem that is fixed from one that is live —
    // `consecutiveFailures: 0` beside a lastError is the recovered state.
    execMock.mockRejectedValueOnce(new Error('transient'));
    await runPollTick();
    execMock.mockResolvedValue([]);
    await runPollTick();

    const res = await request(app()).get(PATH);
    expect(res.body).toMatchObject({
      lastTickOk: true, consecutiveFailures: 0, failingSince: null, lastError: 'transient',
    });
  });

  it('separates the tick verdict from per-item errors inside it', async () => {
    // An unreachable repo is not the same event as a poller that is down, and
    // an operator paging on the wrong one wastes the page. Both numbers are on
    // the wire, so the reader never has to guess which happened.
    await runPollTick();
    const res = await request(app()).get(PATH);
    expect(res.body.lastTickOk).toBe(true);
    expect(res.body.consecutiveFailures).toBe(0);
    expect(res.body).toHaveProperty('lastTickItemErrors');
  });
});
