// routes/local-compute.ts — every route, and the thing that makes this router
// different from every other one: it is mounted UNGATED in index.ts.
//
// That is deliberate (`app.use('/api/local-compute', localComputeRouter)`,
// index.ts:337). Most of its routes are MACHINE callbacks — a developer's
// laptop POSTing presence and pulling work with a node token and no cookie — so a blanket
// `requireSession` at the mount would 401 the whole fleet's presence writes,
// exactly the way a blanket mount once silently killed the agents' trace
// emission (CLAUDE.md, "the auth floor"). The price of an ungated mount is
// that each route's OWN guard is the entire contract, and nothing above it
// will catch a guard that gets dropped in an edit. So the first thing every
// describe block below pins is that route's floor, from both sides:
//
//   * a node-token route rejects a browser session (a cookie is not a token)
//   * a browser route rejects a node token (a token is not a cookie)
//   * GET /nodes/all's bespoke fleet-wide check lets through exactly
//     admin + org-leader + hr-admin, and 403s (not 401s) everyone else
//
// The second thing is response SHAPE — the field names and types a caller
// reads. `mock/core/contract.ts` bug class 2 is a wire string typed from
// memory: the fixture and the unit test agreed with each other and both
// disagreed with the server, and every check stayed green while six
// documents were unreachable. The real reader here is
// `portal/src/components/shell/LocalComputeBadge.tsx`, whose `WireNode` /
// `WireSession` interfaces are transcribed into the key assertions below, so
// a renamed field fails here rather than in a header that quietly renders
// nothing.
//
// Clamping that lib/local-compute-fleet.ts owns (intent → 200 chars,
// touching → 20 entries) is unit-tested there and is NOT re-asserted here.
// What IS asserted is the clamping the ROUTE performs, which nothing else
// covers: the ≤20-session announce cap, the contextUsed [0,1] clamp, the
// non-string `touching` filter, and the 80/64/40-char claim field slices.

// config.ts uses import.meta (unusable under the CJS jest build) and is the
// single switch for both the Aurora-free provider path and the demo-session
// fallback. Cognito is filled in so `demoFallbackAllowed()` is FALSE — with
// the dev fallback on, a cookie-less request silently becomes `demo-user`
// and no 401 in this file would ever be reachable.
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    // Empty policy store → authz decides from the Cedar seed matrix below,
    // which is the real open-mode path (lib/authz.ts seedPolicyDecision).
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: {
      userPoolId: 'us-east-1_TEST', clientId: 'client123', clientSecret: 'secret123',
      domain: 'example.auth.us-east-1.amazoncognito.com',
      callbackUrl: 'http://localhost:3001/api/auth/callback',
      postLoginUrl: '/', logoutRedirectUrl: '/',
    },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
  },
}));

// role-registry reads the .cedar seeds off disk via import.meta.url — same
// reason authz-open-mode.test.ts mocks it. The capability sets mirror
// middleware/seeds/roles/orgiq/*.cedar as of this writing; `program-owner`
// is the one orgiq role whose seed does NOT list ConnectLocalCompute, which
// makes it the honest 403 subject (and the proof that GET /nodes is a
// session floor, not a capability gate — it reads fine).
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '',
      capabilities: ['Search', 'ViewOrgChart', 'ViewObservability', 'LabelFeedback', 'ConnectLocalCompute'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '',
      capabilities: ['Search', 'DispatchAgentRun', 'ManageSprints', 'ConnectLocalCompute'] },
    { id: 'program-owner', tenant: 'orgiq', label: 'Program Owner', summary: '',
      capabilities: ['Search', 'ManageBots', 'ManageSprints', 'ManageBudgets', 'DispatchAgentRun'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'Org Leader', summary: '',
      capabilities: ['Search', 'ViewLeaderboard', 'ApproveTransaction', 'ConnectLocalCompute'] },
    { id: 'hr-admin', tenant: 'orgiq', label: 'HR Admin', summary: '',
      capabilities: ['Search', 'ManageUsers', 'ManageIngest', 'ConnectLocalCompute'] },
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
  ],
}));

// The provider must never reach the Data API under MOCK_AURORA; asserted once
// in the pairing block so a lost mock branch fails loudly rather than by
// timing out against a cluster that isn't there.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import http from 'node:http';
import request, { attachToSharedServer } from '../../test-support/http.js';
import { localComputeRouter } from '../local-compute.js';
import { errorHandler } from '../../lib/async-handler.js';
import { clearAuthzCache } from '../../lib/authz.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { _resetLocalComputeMocks } from '../../providers/local-compute.js';
import { _resetLocalFleet } from '../../lib/local-compute-fleet.js';
import { enqueueJob, getJob, listJobs, _resetMockQueue } from '../../providers/agent-jobs.js';
import * as budgets from '../../providers/budgets.js';
import { _resetLocalComputeLogs } from '../../lib/local-compute-logs.js';
import { _resetLocalComputeNodeLogs } from '../../lib/local-compute-node-logs.js';
import { exec } from '../../providers/aurora.js';
import { type Role, type Session } from '../../lib/session.js';
import { config } from '../../config.js';

const execMock = exec as unknown as jest.Mock;

const BASE = '/api/local-compute';

/**
 * `session: null` builds an app with NO session middleware at all — the
 * cookie-less shape a laptop (and an anonymous internet caller) presents.
 * Because the mocked config has Cognito wired, `resolveSession` does not
 * substitute the demo identity, so these requests really are anonymous.
 */
function buildApp(session: Partial<Session> | null) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      req.session = {
        sub: 'u-mia', role: 'member', tenant: 'orgiq', grants: {}, iat: 0,
        ...session,
      } as Session;
      next();
    });
  }
  app.use(BASE, localComputeRouter);
  app.use(errorHandler);
  return app;
}

const anon = () => buildApp(null);
const as = (role: Role, sub = 'u-mia') => buildApp({ role, sub });

interface Paired { nodeId: string; nodeToken: string }

/** The full handshake: a browser session mints a code, a cookie-less machine
 *  claims it. Every node in this file is created this way rather than by
 *  reaching for the seeded mock fixture, so the tests do not depend on the
 *  fixture's id, owner or token. */
async function pair(
  owner: { sub: string; role?: Role },
  node: { label: string; nodeId?: string; platform?: string },
): Promise<Paired> {
  const started = await request(as(owner.role ?? 'member', owner.sub)).post('/api/local-compute/pair/start').send({});
  expect(started.status).toBe(200);
  const claimed = await request(anon()).post('/api/local-compute/pair/claim')
    .send({ code: started.body.code, node });
  expect(claimed.status).toBe(201);
  return claimed.body as Paired;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  _resetLocalComputeMocks();
  _resetLocalFleet();
  _resetLocalComputeLogs();
  _resetLocalComputeNodeLogs();
  _resetMockQueue();
  resetRateLimits();
  clearAuthzCache();
  execMock.mockReset();
});

afterEach(() => {
  unfreezeClock();
});

// ─── The auth floor, route by route ──────────────────────────────────────────
// Every machine route is fenced by a node token and every browser route by a
// session; the tests above reach them through helpers (pair(), hand(), the
// work-loop wrappers), which the route-coverage scanner cannot see. These are
// the literal calls the scanner reads — and a real assertion each: the floor
// holds with nothing presented.
describe('auth floor: machine routes without a token, browser routes without a session', () => {
  it('rejects every machine route with no bearer token', async () => {
    expect((await request(anon()).post('/api/local-compute/register').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/claim').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/jobs/job-x/start').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/jobs/job-x/heartbeat').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/jobs/job-x/skills').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/jobs/job-x/complete').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/jobs/job-x/log').send({})).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/log').send({})).status).toBe(401);
  });

  it('rejects every browser route with no session', async () => {
    expect((await request(anon()).get('/api/local-compute/runs')).status).toBe(401);
    expect((await request(anon()).get('/api/local-compute/jobs/job-x/log')).status).toBe(401);
    expect((await request(anon()).get('/api/local-compute/jobs/job-x/log/stream')).status).toBe(401);
    expect((await request(anon()).post('/api/local-compute/nodes/node-x/work').send({ prompt: 'x' })).status).toBe(401);
    expect((await request(anon()).get('/api/local-compute/nodes/node-x/log')).status).toBe(401);
    expect((await request(anon()).get('/api/local-compute/nodes/node-x/log/stream')).status).toBe(401);
  });
});

// ─── GET /pair/:code — the minting browser watches its own code ──────────────
describe('GET /api/local-compute/pair/:code', () => {
  it('reads unclaimed, then claimed with the node id, for the code\'s owner only', async () => {
    const started = await request(as('member', 'u-mia')).post('/api/local-compute/pair/start').send({});
    expect(started.status).toBe(200);
    const code = started.body.code as string;

    const before = await request(as('member', 'u-mia')).get(`/api/local-compute/pair/${code}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ code, claimed: false, claimedAt: null, nodeId: null });

    // Someone else's session sees the same answer as a code that never existed.
    const other = await request(as('member', 'u-theo')).get(`/api/local-compute/pair/${code}`);
    expect(other.status).toBe(404);

    const claimed = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code, node: { label: 'mia-laptop', nodeId: 'node-mia-1' } });
    expect(claimed.status).toBe(201);

    const after = await request(as('member', 'u-mia')).get(`/api/local-compute/pair/${code}`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ claimed: true, nodeId: 'node-mia-1' });
    expect(after.body.claimedAt).toBeTruthy();
  });

  it('404s an unknown code', async () => {
    const res = await request(as('member', 'u-mia')).get('/api/local-compute/pair/NOPE2345');
    expect(res.status).toBe(404);
  });
});

// ─── POST /pair/start — requireAction('ConnectLocalCompute') ─────────────────

describe('POST /api/local-compute/pair/start', () => {
  it('401s a cookie-less caller — minting a pairing code is a browser act', async () => {
    const res = await request(anon()).post('/api/local-compute/pair/start').send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated' });
  });

  it('403s a signed-in role whose Cedar seed does not list ConnectLocalCompute', async () => {
    const res = await request(as('program-owner')).post('/api/local-compute/pair/start').send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Forbidden', action: 'ConnectLocalCompute', role: 'program-owner' });
  });

  it('returns exactly { code, expiresAt } — the token is minted at CLAIM, never here', async () => {
    const res = await request(as('member')).post('/api/local-compute/pair/start').send({});
    expect(res.status).toBe(200);
    // Exact keys: a code response that also carried the node token would let
    // the browser (and anything reading its network log) hold the machine
    // credential, which the whole handshake exists to avoid.
    expect(Object.keys(res.body).sort()).toEqual(['code', 'expiresAt']);
    expect(typeof res.body.code).toBe('string');
    expect(res.body.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    expect(execMock).not.toHaveBeenCalled(); // mock path, no Data API
  });

  it('is reachable by every role the seeds grant it, not just leaders', async () => {
    for (const role of ['member', 'sme', 'org-leader', 'hr-admin', 'admin'] as Role[]) {
      const res = await request(as(role)).post('/api/local-compute/pair/start').send({});
      expect([role, res.status]).toEqual([role, 200]);
    }
  });
});

// ─── POST /pair/claim — no session, rate-limited ─────────────────────────────

describe('POST /api/local-compute/pair/claim', () => {
  it('succeeds with NO session — the code is the entire credential', async () => {
    const started = await request(as('member')).post('/api/local-compute/pair/start').send({});
    const res = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: started.body.code, node: { label: 'mia-mbp', platform: 'darwin/arm64' } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['nodeId', 'nodeToken']);
    expect(typeof res.body.nodeId).toBe('string');
    expect(res.body.nodeToken).toMatch(/^lcn_[0-9a-f]{48}$/);
  });

  it('400s when the code or the label is missing — both are required', async () => {
    const started = await request(as('member')).post('/api/local-compute/pair/start').send({});
    const noLabel = await request(anon()).post('/api/local-compute/pair/claim').send({ code: started.body.code, node: {} });
    expect(noLabel.status).toBe(400);
    expect(noLabel.body).toEqual({ error: 'code and node.label are required' });

    const noCode = await request(anon()).post('/api/local-compute/pair/claim').send({ node: { label: 'x' } });
    expect(noCode.status).toBe(400);

    // A whitespace-only label is not a label.
    const blankLabel = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: started.body.code, node: { label: '   ' } });
    expect(blankLabel.status).toBe(400);
  });

  it('404s an unknown code with a message that reveals nothing about which codes exist', async () => {
    const res = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: 'ZZZZZZZZ', node: { label: 'probe' } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'pairing code invalid or expired' });
  });

  it('is single-use: the second claim of the same code is indistinguishable from an unknown one', async () => {
    const started = await request(as('member')).post('/api/local-compute/pair/start').send({});
    const first = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: started.body.code, node: { label: 'first' } });
    expect(first.status).toBe(201);

    const second = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: started.body.code, node: { label: 'second' } });
    expect(second.status).toBe(404);
    // Same body as the unknown-code case above — a spent code and a fictional
    // one must not be tellable apart.
    expect(second.body).toEqual({ error: 'pairing code invalid or expired' });
  });

  it('404s a code past its 10-minute TTL', async () => {
    const t0 = new Date('2026-03-02T10:00:00.000Z');
    let restore = freezeClock(t0);
    const started = await request(as('member')).post('/api/local-compute/pair/start').send({});
    expect(started.status).toBe(200);
    restore();

    restore = freezeClock(new Date(t0.getTime() + 11 * 60_000));
    const res = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: started.body.code, node: { label: 'late' } });
    restore();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'pairing code invalid or expired' });
  });

  it('still honours a code claimed just inside the TTL', async () => {
    const t0 = new Date('2026-03-02T10:00:00.000Z');
    let restore = freezeClock(t0);
    const started = await request(as('member')).post('/api/local-compute/pair/start').send({});
    restore();
    restore = freezeClock(new Date(t0.getTime() + 9 * 60_000));
    const res = await request(anon()).post('/api/local-compute/pair/claim')
      .send({ code: started.body.code, node: { label: 'just-in-time' } });
    restore();
    expect(res.status).toBe(201);
  });

  it('rate-limits the handshake at 30 per minute per IP, and only that IP', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    const app = anon();
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app).post('/api/local-compute/pair/claim').set(ip)
        .send({ code: 'ZZZZZZZZ', node: { label: 'probe' } });
      expect([i, res.status]).toEqual([i, 404]); // rejected on merit, not throttled
    }
    const throttled = await request(app).post('/api/local-compute/pair/claim').set(ip)
      .send({ code: 'ZZZZZZZZ', node: { label: 'probe' } });
    expect(throttled.status).toBe(429);
    expect(throttled.body).toEqual({ error: 'Too many requests', bucket: 'local-compute-claim' });
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);

    // The window is per-IP: one laptop brute-forcing codes must not lock out
    // the developer next to it.
    const other = await request(app).post('/api/local-compute/pair/claim').set({ 'x-forwarded-for': '198.51.100.4' })
      .send({ code: 'ZZZZZZZZ', node: { label: 'probe' } });
    expect(other.status).toBe(404);
  });

  it('slices the caller-supplied label, nodeId and platform to their column widths', async () => {
    const started = await request(as('member')).post('/api/local-compute/pair/start').send({});
    const claimed = await request(anon()).post('/api/local-compute/pair/claim').send({
      code: started.body.code,
      node: { nodeId: 'n'.repeat(200), label: 'L'.repeat(200), platform: 'p'.repeat(200) },
    });
    expect(claimed.status).toBe(201);
    expect(claimed.body.nodeId).toHaveLength(64);

    const listed = await request(as('member')).get('/api/local-compute/nodes');
    const node = listed.body.nodes.find((n: { id: string }) => n.id === claimed.body.nodeId);
    expect(node.label).toHaveLength(80);
    expect(node.platform).toHaveLength(40);
  });
});

// ─── POST /announce — requireNodeToken ───────────────────────────────────────

describe('POST /api/local-compute/announce', () => {
  const sessionRecord = {
    sessionId: 's-abc',
    harness: 'claude-code',
    projectId: 'p-realtime',
    repo: 'realtime-platform',
    branch: 'feat/mesh',
    worktree: '/Users/mia/wt/mesh',
    intent: 'wire the presence mesh',
    touching: ['src/a.ts', 'src/b.ts'],
    modelProvider: 'ollama',
    model: 'qwen2.5-coder:14b',
    contextUsed: 0.4,
    memory: { mode: 'pending', pendingOps: 3 },
    startedAt: 1_772_000_000_000,
  };

  it('401s with no Authorization header', async () => {
    const res = await request(anon()).post('/api/local-compute/announce').send({ sessions: [] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid or revoked node token' });
  });

  it('401s a BROWSER SESSION with no node token — a cookie is not a machine credential', async () => {
    // The whole reason this router is mounted ungated. If someone "fixed" the
    // machine routes by letting a session through, presence writes would
    // become forgeable by any signed-in user against any node.
    const res = await request(as('admin')).post('/api/local-compute/announce').send({ sessions: [] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid or revoked node token' });
  });

  it('401s a malformed or non-lcn_ bearer token', async () => {
    for (const token of ['', 'not-a-token', 'Bearer', 'lcn_deadbeef']) {
      const res = await request(anon()).post('/api/local-compute/announce')
        .set({ Authorization: `Bearer ${token}` }).send({ sessions: [] });
      expect([token, res.status]).toEqual([token, 401]);
    }
  });

  it('accepts a valid node token with no session and answers { ok, nodeId, sessions }', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post('/api/local-compute/announce')
      .set(bearer(node.nodeToken)).send({ sessions: [sessionRecord] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, nodeId: node.nodeId, sessions: 1 });
  });

  it('is a SNAPSHOT: a session absent from the next announce is dropped, not lingered', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [sessionRecord, { ...sessionRecord, sessionId: 's-two' }] });

    const second = await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [{ ...sessionRecord, sessionId: 's-two' }] });
    expect(second.body.sessions).toBe(1);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    const ids = listed.body.nodes[0].presence.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toEqual(['s-two']);
  });

  it('400s a non-array body, a record with no sessionId, and more than 20 sessions', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const post = (body: unknown) => request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send(body as object);

    expect((await post({})).status).toBe(400);
    expect((await post({ sessions: 'nope' })).status).toBe(400);
    expect((await post({ sessions: [null] })).status).toBe(400);
    // A record with no sessionId is REJECTED at the route, not silently
    // dropped further down — the machine gets told its snapshot was wrong.
    const noId = await post({ sessions: [{ harness: 'claude-code' }] });
    expect(noId.status).toBe(400);
    expect(noId.body.error).toMatch(/≤20 session records/);

    const twenty = Array.from({ length: 20 }, (_, i) => ({ sessionId: `s-${i}` }));
    expect((await post({ sessions: twenty })).status).toBe(200);
    expect((await post({ sessions: [...twenty, { sessionId: 's-20' }] })).status).toBe(400);
  });

  it('clamps contextUsed into [0,1] and drops non-string touching entries at the route', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({
      sessions: [
        { sessionId: 'hot', contextUsed: 5, touching: ['ok.ts', 42, null, 'also.ts'] },
        { sessionId: 'cold', contextUsed: -3 },
        { sessionId: 'nan', contextUsed: Number.NaN },
      ],
    });
    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    const byId = Object.fromEntries(
      listed.body.nodes[0].presence.sessions.map((s: { sessionId: string }) => [s.sessionId, s]),
    );
    expect(byId['hot'].contextUsed).toBe(1);
    expect(byId['cold'].contextUsed).toBe(0);
    // A non-finite number is not a fraction — the field is omitted rather
    // than serialized as null, which the badge would render as 0%.
    expect(byId['nan']).not.toHaveProperty('contextUsed');
    expect(byId['hot'].touching).toEqual(['ok.ts', 'also.ts']);
    // Absent optional fields stay absent rather than becoming undefined keys.
    expect(byId['cold']).not.toHaveProperty('repo');
    expect(byId['cold'].harness).toBe('unknown');
  });

  it('stops authenticating the moment the owner revokes the node', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    expect((await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [] })).status).toBe(200);

    const revoked = await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`);
    expect(revoked.status).toBe(200);

    const after = await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [] });
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: 'invalid or revoked node token' });
  });
});

// ─── POST /announce — the optional `metrics` object ──────────────────────────
//
// Attached to /announce, not /heartbeat: tools/local-compute-worker.mjs's
// presence loop only ever calls /announce on a repeating timer (job
// heartbeats hit a different, per-job route) — see the route's own comment.

describe('POST /api/local-compute/announce — metrics', () => {
  const metrics = {
    loadAvg1: 1.25, cpuCount: 10, memTotalMb: 32_768, memFreeMb: 8_192,
    uptimeS: 12_345, workerVersion: '1.1.0', activeJobs: 1,
  };

  it('is a no-op when absent — an older worker keeps working byte-for-byte', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post('/api/local-compute/announce')
      .set(bearer(node.nodeToken)).send({ sessions: [] });
    expect(res.status).toBe(200);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes[0].metrics).toBeNull();
  });

  it('stores a valid metrics object and surfaces it on GET /nodes with the observation time', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post('/api/local-compute/announce')
      .set(bearer(node.nodeToken)).send({ sessions: [], metrics });
    expect(res.status).toBe(200);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    const seen = listed.body.nodes[0].metrics;
    expect(seen).toMatchObject(metrics);
    expect(Date.parse(seen.at)).not.toBeNaN();
  });

  it('leaves a previously stored snapshot alone when a later announce sends none', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [], metrics });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [] });

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes[0].metrics).toMatchObject(metrics);
  });

  it('accepts a partial object — every field is independently optional', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post('/api/local-compute/announce')
      .set(bearer(node.nodeToken)).send({ sessions: [], metrics: { loadAvg1: 0.5 } });
    expect(res.status).toBe(200);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes[0].metrics).toMatchObject({ loadAvg1: 0.5 });
    expect(listed.body.nodes[0].metrics).not.toHaveProperty('cpuCount');
  });

  it('rejects a bad payload — a non-object, a negative/non-finite/absurd number, a non-string version', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const post = (m: unknown) => request(anon()).post('/api/local-compute/announce')
      .set(bearer(node.nodeToken)).send({ sessions: [], metrics: m });

    for (const bad of [
      'nope',
      42,
      ['not', 'an', 'object'],
      { loadAvg1: -1 },
      { loadAvg1: Number.NaN },
      { loadAvg1: Number.POSITIVE_INFINITY },
      { cpuCount: 4.5 }, // must be an integer
      { memTotalMb: 1_000_000_000_000 }, // past the absurd ceiling
      { workerVersion: 12345 },
    ]) {
      const res = await post(bad);
      expect([bad, res.status]).toEqual([bad, 400]);
    }

    // Nothing from any rejected call was stored.
    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes[0].metrics).toBeNull();
  });

  it('clamps workerVersion to 40 chars', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [], metrics: { workerVersion: 'v'.repeat(80) } });

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes[0].metrics.workerVersion).toHaveLength(40);
  });

  it('hides metrics once the machine ages past the offline horizon, like sessions', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [], metrics });

    const restore = freezeClock(new Date(Date.now() + 10 * 60_000)); // past the offline horizon
    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    restore();
    expect(listed.body.nodes[0].presence.status).toBe('offline');
    expect(listed.body.nodes[0].metrics).toBeNull();
  });
});

// ─── POST /heartbeat — requireNodeToken ──────────────────────────────────────

describe('POST /api/local-compute/heartbeat', () => {
  it('401s with no token and with a browser session instead of one', async () => {
    expect((await request(anon()).post('/api/local-compute/heartbeat').send({})).status).toBe(401);
    expect((await request(as('admin')).post('/api/local-compute/heartbeat').send({})).status).toBe(401);
  });

  it('answers exactly { ok: true } for a valid token', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post('/api/local-compute/heartbeat').set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does NOT invent presence for a node that has never announced', async () => {
    // recordHeartbeat is a no-op without prior state: proof of life is not
    // proof of sessions, and a machine that only heartbeats must still read
    // as offline rather than as a connected node with nothing running.
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/heartbeat').set(bearer(node.nodeToken)).send({});

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    const presence = listed.body.nodes.find((n: { id: string }) => n.id === node.nodeId).presence;
    expect(presence.status).toBe('offline');
    expect(presence.lastSeenAt).toBeNull();
  });

  it('refreshes an announced node so its derived status stays connected', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [{ sessionId: 's-1' }] });
    await request(anon()).post('/api/local-compute/heartbeat').set(bearer(node.nodeToken)).send({});

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    const presence = listed.body.nodes.find((n: { id: string }) => n.id === node.nodeId).presence;
    expect(presence.status).toBe('connected');
    expect(Date.parse(presence.lastSeenAt)).not.toBeNaN();
    expect(presence.sessions).toHaveLength(1);
  });
});

// ─── POST /sessions/:sessionId/end — requireNodeToken ────────────────────────

describe('POST /api/local-compute/sessions/:sessionId/end', () => {
  it('401s with no token and with a browser session instead of one', async () => {
    expect((await request(anon()).post('/api/local-compute/sessions/s-1/end').send({})).status).toBe(401);
    expect((await request(as('admin')).post('/api/local-compute/sessions/s-1/end').send({})).status).toBe(401);
  });

  it('removes the session and reports removed: true, then false on the repeat', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [{ sessionId: 's-1' }, { sessionId: 's-2' }] });

    const first = await request(anon()).post('/api/local-compute/sessions/s-1/end').set(bearer(node.nodeToken)).send({});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, removed: true });

    const again = await request(anon()).post('/api/local-compute/sessions/s-1/end').set(bearer(node.nodeToken)).send({});
    expect(again.body).toEqual({ ok: true, removed: false });

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    const ids = listed.body.nodes[0].presence.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toEqual(['s-2']);
  });

  it('200s with removed: false for a session id that is not there — an unknown id is not an error', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [] });
    const res = await request(anon()).post('/api/local-compute/sessions/never-existed/end').set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: false });
  });

  it('cannot end a session belonging to a DIFFERENT node — the end is scoped to the token', async () => {
    const mine = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(theirs.nodeToken))
      .send({ sessions: [{ sessionId: 's-raj' }] });

    const res = await request(anon()).post('/api/local-compute/sessions/s-raj/end').set(bearer(mine.nodeToken)).send({});
    expect(res.body).toEqual({ ok: true, removed: false });

    const stillThere = await request(as('member', 'u-raj')).get('/api/local-compute/nodes');
    expect(stillThere.body.nodes[0].presence.sessions).toHaveLength(1);
  });
});

// ─── GET /nodes — requireSession, owner-scoped, FULL session detail ──────────

describe('GET /api/local-compute/nodes', () => {
  it('401s a cookie-less caller', async () => {
    const res = await request(anon()).get('/api/local-compute/nodes');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated' });
  });

  it('401s a NODE TOKEN — a machine credential is not a browser session', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).get('/api/local-compute/nodes').set(bearer(node.nodeToken));
    expect(res.status).toBe(401);
  });

  it('is a session FLOOR, not a capability gate: a role without ConnectLocalCompute still reads', async () => {
    // requireSession('ViewLocalCompute') gates authentication only — the label
    // is an audit string, and ViewLocalCompute is not a Cedar action. If this
    // ever 403s, someone swapped the floor for requireAction and locked out
    // every role whose seed does not name it.
    const res = await request(as('program-owner')).get('/api/local-compute/nodes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
  });

  it('returns the full node + presence wire shape the header badge reads', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp', platform: 'darwin/arm64' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({
      sessions: [{
        sessionId: 's-abc', harness: 'claude-code', projectId: 'p-realtime',
        repo: 'realtime-platform', branch: 'feat/mesh', worktree: '/wt/mesh',
        intent: 'wire the presence mesh', modelProvider: 'ollama',
        model: 'qwen2.5-coder:14b', contextUsed: 0.4,
        memory: { mode: 'pending', pendingOps: 3 }, startedAt: 1_772_000_000_000,
      }],
    });

    const res = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['nodes']);

    const row = res.body.nodes.find((n: { id: string }) => n.id === node.nodeId);
    expect(Object.keys(row).sort()).toEqual([
      'acceptJobs', 'createdAt', 'id', 'jobKinds', 'label', 'lastClaimAt', 'lastSeenAt',
      'localModels', 'maxConcurrency', 'metrics', 'ownerId', 'platform', 'presence', 'revokedAt',
    ]);
    // This announce carried no `metrics` — an older-worker announce, byte for
    // byte. Absent is null, never a fabricated snapshot.
    expect(row.metrics).toBeNull();
    expect(row.ownerId).toBe('u-mia');
    expect(row.label).toBe('mia-mbp');
    expect(row.platform).toBe('darwin/arm64');
    expect(row.acceptJobs).toBe(false);
    expect(row.localModels).toEqual([]);
    // A freshly paired machine has advertised NOTHING. Both defaults are the
    // conservative reading and both are load-bearing: empty `jobKinds` makes
    // the claim route refuse (an unregistered worker has no capabilities, it does
    // not inherit the server's whole set), and `maxConcurrency: 1` means a
    // machine that never says otherwise runs one job at a time.
    expect(row.jobKinds).toEqual([]);
    expect(row.maxConcurrency).toBe(1);
    expect(row.revokedAt).toBeNull();
    expect(Date.parse(row.createdAt)).not.toBeNaN();
    expect(Date.parse(row.lastSeenAt)).not.toBeNaN(); // stamped by touchNode

    expect(Object.keys(row.presence).sort()).toEqual(['lastSeenAt', 'nodeId', 'sessions', 'status']);
    expect(row.presence.nodeId).toBe(node.nodeId);
    expect(row.presence.status).toBe('connected');

    // The session field names are transcribed from LocalComputeBadge's
    // WireSession, plus the server-stamped lastSeenAt.
    const session = row.presence.sessions[0];
    expect(Object.keys(session).sort()).toEqual([
      'branch', 'contextUsed', 'harness', 'intent', 'lastSeenAt', 'memory',
      'model', 'modelProvider', 'projectId', 'repo', 'sessionId', 'startedAt', 'worktree',
    ]);
    expect(session.memory).toEqual({ mode: 'pending', pendingOps: 3 });
    expect(session.startedAt).toBe(1_772_000_000_000);
    // lastSeenAt is stamped SERVER-side, never taken from the machine.
    expect(Date.parse(session.lastSeenAt)).not.toBeNaN();
  });

  it('lists only the caller\'s own machines, even for an admin', async () => {
    const mine = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });

    const mia = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(mia.body.nodes.map((n: { id: string }) => n.id)).toEqual([mine.nodeId]);

    // /nodes is "my machines" for everyone — an admin's personal view is not
    // the fleet view. That is what GET /nodes/all is for.
    const admin = await request(as('admin', 'u-ops')).get('/api/local-compute/nodes');
    expect(admin.body.nodes.map((n: { id: string }) => n.id)).not.toContain(mine.nodeId);
    expect(admin.body.nodes.map((n: { id: string }) => n.id)).not.toContain(theirs.nodeId);
  });
});

// ─── GET /nodes/all — the bespoke fleet-wide gate ────────────────────────────

// ─── tenant isolation ────────────────────────────────────────────────────────
//
// Filtering by OWNER is not the same question as which workspace you are in.
// An assessment user who also owns an orgiq machine saw it, and the initiative
// and branch it was working on, in the assessment header — with an action
// leading out of the tenant. The browser half of this router is orgiq-only;
// the machine half must stay reachable with no session at all.
describe('tenant isolation', () => {
  const assessmentSession: Partial<Session> = { tenant: 'assessment', role: 'assessor' as Role };

  it.each([
    ['get', '/api/local-compute/nodes'],
    ['get', '/api/local-compute/stream'],
    ['post', '/api/local-compute/pair/start'],
    ['patch', '/api/local-compute/nodes/node-operator-thinkpad'],
    ['delete', '/api/local-compute/nodes/node-operator-thinkpad'],
  ])('403s an assessment session on %s %s', async (method, path) => {
    const res = await (request(buildApp(assessmentSession)) as never as Record<string, (p: string) => Promise<{ status: number; body: { requiredTenant?: string } }>>)[method]!(path);
    expect(res.status).toBe(403);
    expect(res.body.requiredTenant).toBe('orgiq');
  });

  it('leaves the machine callbacks reachable with no session', async () => {
    const paired = await pair({ sub: 'u-mia' }, { label: 'tenant-probe' });
    const res = await request(buildApp(null))
      .post('/api/local-compute/heartbeat')
      .set(bearer(paired.nodeToken));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/local-compute/nodes/all', () => {
  it('403s (not 401s) a cookie-less caller, naming the action it wanted', async () => {
    const res = await request(anon()).get('/api/local-compute/nodes/all');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
  });

  it('lets through exactly admin, org-leader and hr-admin', async () => {
    for (const role of ['admin', 'org-leader', 'hr-admin'] as Role[]) {
      const res = await request(as(role, 'u-ops')).get('/api/local-compute/nodes/all');
      expect([role, res.status]).toEqual([role, 200]);
    }
  });

  it('403s every other role, including one that holds ConnectLocalCompute', async () => {
    // ConnectLocalCompute is PERSONAL authority (pair and manage your own
    // machine); it is deliberately not fleet visibility. An SME holds it and
    // still must not see the fleet.
    for (const role of ['member', 'sme', 'program-owner'] as Role[]) {
      const res = await request(as(role)).get('/api/local-compute/nodes/all');
      expect([role, res.status]).toEqual([role, 403]);
      expect(res.body).toEqual({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
    }
  });

  it('summarizes: sessionCount instead of the sessions themselves', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({
      sessions: [
        { sessionId: 's-1', intent: 'refactor the billing ledger', worktree: '/Users/mia/secret' },
        { sessionId: 's-2', intent: 'read the incident postmortem' },
      ],
    });

    const res = await request(as('org-leader', 'u-ops')).get('/api/local-compute/nodes/all');
    const row = res.body.nodes.find((n: { id: string }) => n.id === node.nodeId);
    expect(Object.keys(row.presence).sort()).toEqual(['lastSeenAt', 'nodeId', 'sessionCount', 'status']);
    expect(row.presence.sessionCount).toBe(2);
    expect(row.presence).not.toHaveProperty('sessions');
    // Belt and braces: no intent or worktree string anywhere in the payload.
    // Fleet-wide roles learn that machines are busy, never what they are on.
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('refactor the billing ledger');
    expect(wire).not.toContain('/Users/mia/secret');
  });

  it('spans owners — the node half of the row is the same shape /nodes returns', async () => {
    const mine = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
    const res = await request(as('hr-admin', 'u-ops')).get('/api/local-compute/nodes/all');
    const ids = res.body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(expect.arrayContaining([mine.nodeId, theirs.nodeId]));

    const row = res.body.nodes.find((n: { id: string }) => n.id === mine.nodeId);
    expect(Object.keys(row).sort()).toEqual([
      'acceptJobs', 'createdAt', 'id', 'jobKinds', 'label', 'lastClaimAt', 'lastSeenAt',
      'localModels', 'maxConcurrency', 'ownerId', 'platform', 'presence', 'revokedAt',
    ]);
  });

  it('drops a revoked machine from the fleet listing', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`);
    const res = await request(as('org-leader', 'u-ops')).get('/api/local-compute/nodes/all');
    expect(res.body.nodes.map((n: { id: string }) => n.id)).not.toContain(node.nodeId);
  });
});

// ─── GET /presence/repos — org-wide, redacted to repo counts only ────────────

describe('GET /api/local-compute/presence/repos', () => {
  it('403s (not 401s) a cookie-less caller, naming the action it wanted', async () => {
    const res = await request(anon()).get('/api/local-compute/presence/repos');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
  });

  it('403s a role that is not fleet-wide, including one that holds ConnectLocalCompute', async () => {
    for (const role of ['member', 'sme', 'program-owner'] as Role[]) {
      const res = await request(as(role)).get('/api/local-compute/presence/repos');
      expect([role, res.status]).toEqual([role, 403]);
      expect(res.body).toEqual({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
    }
  });

  it('lets through exactly admin, org-leader and hr-admin', async () => {
    for (const role of ['admin', 'org-leader', 'hr-admin'] as Role[]) {
      const res = await request(as(role, 'u-ops')).get('/api/local-compute/presence/repos');
      expect([role, res.status]).toEqual([role, 200]);
      expect(res.body).toEqual({ repos: [] });
    }
  });

  it('aggregates live sessions by repo, across owners and machines, redacted to counts', async () => {
    const mine = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
    // Two machines, two sessions each, on the same repo — plus one machine
    // with a session on a second repo, so the aggregation is exercised, not
    // just a pass-through.
    await request(anon()).post('/api/local-compute/announce').set(bearer(mine.nodeToken)).send({
      sessions: [
        { sessionId: 's-1', repo: 'org/shared-repo', intent: 'refactor the billing ledger', worktree: '/Users/mia/secret' },
        { sessionId: 's-2', repo: 'org/only-mine' },
      ],
    });
    await request(anon()).post('/api/local-compute/announce').set(bearer(theirs.nodeToken)).send({
      sessions: [
        { sessionId: 's-3', repo: 'org/shared-repo', model: 'amazon.nova-pro-v1:0' },
      ],
    });

    const res = await request(as('org-leader', 'u-ops')).get('/api/local-compute/presence/repos');
    expect(res.status).toBe(200);
    expect(res.body.repos).toEqual(expect.arrayContaining([
      { repo: 'org/shared-repo', machines: 2, sessions: 2, lastSeenAt: expect.any(String) },
      { repo: 'org/only-mine', machines: 1, sessions: 1, lastSeenAt: expect.any(String) },
    ]));

    // Every row is exactly this shape — no room for a stray field to sneak in.
    for (const row of res.body.repos) {
      expect(Object.keys(row).sort()).toEqual(['lastSeenAt', 'machines', 'repo', 'sessions']);
    }

    // Redaction, belt and braces: no node id, label, session id, intent,
    // worktree or model anywhere in the payload — the whole point of this
    // route being safe to show org-wide.
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain(mine.nodeId);
    expect(wire).not.toContain(theirs.nodeId);
    expect(wire).not.toContain('mia-mbp');
    expect(wire).not.toContain('raj-mbp');
    expect(wire).not.toContain('s-1');
    expect(wire).not.toContain('s-2');
    expect(wire).not.toContain('s-3');
    expect(wire).not.toContain('refactor the billing ledger');
    expect(wire).not.toContain('/Users/mia/secret');
    expect(wire).not.toContain('amazon.nova-pro-v1:0');
  });

  it('excludes sessions with no repo, and never counts an offline machine', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({
      sessions: [{ sessionId: 's-1' }], // no repo
    });
    const before = await request(as('admin', 'u-ops')).get('/api/local-compute/presence/repos');
    expect(before.body).toEqual({ repos: [] });

    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({
      sessions: [{ sessionId: 's-2', repo: 'org/repo' }],
    });
    const restore = freezeClock(new Date(Date.now() + 10 * 60_000)); // past the offline horizon
    const after = await request(as('admin', 'u-ops')).get('/api/local-compute/presence/repos');
    restore();
    expect(after.body).toEqual({ repos: [] });
  });
});

// ─── GET /stream — SSE, owner-scoped ─────────────────────────────────────────

/**
 * Read an SSE stream over a raw socket — supertest buffers a whole response
 * before resolving, which a stream that never ends does not do. The socket
 * still goes to the file's ONE shared server (test-support/http.ts), same as
 * assessment-events-gap.test.ts.
 */
function readStream(
  app: express.Express,
  until: (buf: string) => boolean,
  opts: { headers?: Record<string, string>; timeoutMs?: number; path?: string } = {},
): Promise<string> {
  const { port, headers: appHeaders } = attachToSharedServer(app);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: opts.path ?? '/api/local-compute/stream', headers: { ...appHeaders, ...(opts.headers ?? {}) } },
      (res) => {
        let buf = '';
        const done = () => { clearTimeout(timer); req.destroy(); resolve(buf); };
        const timer = setTimeout(done, opts.timeoutMs ?? 500);
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          if (until(buf)) done();
        });
        res.on('error', () => done());
      },
    );
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve('');
      else reject(err);
    });
  });
}

describe('GET /api/local-compute/stream', () => {
  it('401s a cookie-less caller before opening a stream', async () => {
    // Denials terminate, so supertest is the right tool here — and this is
    // the assertion that would catch the floor being removed from the one
    // route whose success case can never be a plain request().
    const res = await request(anon()).get('/api/local-compute/stream');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated' });
  });

  it('401s a node token — the stream is a browser surface', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).get('/api/local-compute/stream').set(bearer(node.nodeToken));
    expect(res.status).toBe(401);
  });

  it('opens with a presence frame per owned machine, then pushes on every announce', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const app = buildApp({ role: 'member', sub: 'u-mia' });

    const streamed = readStream(app, (b) => b.includes('"sessionId":"s-live"'));
    await new Promise((r) => setTimeout(r, 50));
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [{ sessionId: 's-live', intent: 'live work' }] });

    const buf = await streamed;
    const frames = buf.split('\n\n').filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice('data: '.length)));
    // Opening snapshot: the machine exists, with no presence yet.
    expect(frames[0]).toMatchObject({
      type: 'presence',
      node: { id: node.nodeId, label: 'mia-mbp', presence: { status: 'offline', sessions: [] } },
    });
    // Live frame carries the same node+presence shape /nodes returns.
    const live = frames[frames.length - 1];
    expect(live.type).toBe('presence');
    expect(live.node.id).toBe(node.nodeId);
    expect(live.node.presence.status).toBe('connected');
    expect(live.node.presence.sessions[0].sessionId).toBe('s-live');
  });

  it('never emits another owner\'s machine, even when that machine announces', async () => {
    await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
    const app = buildApp({ role: 'member', sub: 'u-mia' });

    const streamed = readStream(app, () => false, { timeoutMs: 400 });
    await new Promise((r) => setTimeout(r, 50));
    await request(anon()).post('/api/local-compute/announce').set(bearer(theirs.nodeToken))
      .send({ sessions: [{ sessionId: 's-raj', intent: 'raj private work' }] });

    const buf = await streamed;
    expect(buf).toContain('mia-mbp');       // her own opening frame arrived
    expect(buf).not.toContain(theirs.nodeId);
    expect(buf).not.toContain('raj private work');
  });
});

// ─── GET /events — presence + job SSE, owner-scoped ──────────────────────────
//
// Additive to /stream, not a replacement: a hello snapshot on connect (so the
// client never needs a second GET /nodes just to bootstrap), presence frames
// carrying `metrics` alongside status, and job frames for this owner's
// machines — targeted-but-unclaimed jobs included, via payload.nodeId, since
// box_id does not exist until a job is claimed.

describe('GET /api/local-compute/events', () => {
  const framesOf = (buf: string) =>
    buf.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => JSON.parse(f.slice('data: '.length)));

  it('401s a cookie-less caller before opening a stream', async () => {
    const res = await request(anon()).get('/api/local-compute/events');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthenticated' });
  });

  it('401s a node token — the stream is a browser surface', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).get('/api/local-compute/events').set(bearer(node.nodeToken));
    expect(res.status).toBe(401);
  });

  it('opens with a hello snapshot in the same shape GET /nodes returns', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const app = buildApp({ role: 'member', sub: 'u-mia' });

    const buf = await readStream(app, (b) => b.includes('"type":"hello"'), { path: '/api/local-compute/events' });
    const frames = framesOf(buf);
    expect(frames[0].type).toBe('hello');
    expect(frames[0].nodes).toHaveLength(1);
    expect(frames[0].nodes[0]).toMatchObject({
      id: node.nodeId, label: 'mia-mbp', metrics: null,
      presence: { status: 'offline', sessions: [] },
    });
  });

  it('pushes a presence frame carrying metrics on announce', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const app = buildApp({ role: 'member', sub: 'u-mia' });

    const streamed = readStream(app, (b) => b.includes('"type":"presence"'), { path: '/api/local-compute/events' });
    await new Promise((r) => setTimeout(r, 50));
    await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken))
      .send({ sessions: [], metrics: { loadAvg1: 0.9, cpuCount: 8 } });

    const frames = framesOf(await streamed);
    const presence = frames.find((f) => f.type === 'presence');
    expect(presence).toMatchObject({
      nodeId: node.nodeId, status: 'connected', metrics: { loadAvg1: 0.9, cpuCount: 8 },
    });
    expect(Date.parse(presence.lastSeenAt)).not.toBeNaN();
  });

  it('pushes job frames through queued → claimed → done, all carrying THIS machine\'s nodeId', async () => {
    const node = await readyWorker({ sub: 'u-mia' });
    const app = buildApp({ role: 'member', sub: 'u-mia' });

    const streamed = readStream(app, (b) => b.includes('"status":"done"'), {
      path: '/api/local-compute/events', timeoutMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 50));

    const handed = await request(as('member', 'u-mia')).post(`${BASE}/nodes/${node.nodeId}/work`)
      .send({ prompt: 'distill yesterday' });
    expect(handed.status).toBe(201);

    const claimed = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(claimed.status).toBe(200);
    const completed = await request(anon()).post(`${BASE}/jobs/${claimed.body.job.id}/complete`)
      .set(bearer(node.nodeToken)).send({ claimToken: claimed.body.claimToken, status: 'done' });
    expect(completed.status).toBe(200);

    const jobFrames = framesOf(await streamed).filter((f) => f.type === 'job');
    expect(jobFrames.map((f) => f.status)).toEqual(['queued', 'claimed', 'done']);
    for (const f of jobFrames) {
      expect(f.nodeId).toBe(node.nodeId);
      expect(f.jobId).toBe(claimed.body.job.id);
      expect(typeof f.title).toBe('string');
      expect(Date.parse(f.at)).not.toBeNaN();
    }
  });

  it('books a finished local job to the ledger as a confident $0 with provider local (DE-33)', async () => {
    const { mockStoredEntries } = await import('../../providers/spend-ledger.js');
    const node = await readyWorker({ sub: 'u-mia' });
    const handed = await request(as('member', 'u-mia')).post(`${BASE}/nodes/${node.nodeId}/work`).send({ prompt: 'distill yesterday' });
    expect(handed.status).toBe(201);
    const claimed = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    const done = await request(anon()).post(`${BASE}/jobs/${claimed.body.job.id}/complete`)
      .set(bearer(node.nodeToken)).send({ claimToken: claimed.body.claimToken, status: 'done', costUsd: 4.2, model: 'sonnet' });
    expect(done.status).toBe(200);
    const entry = mockStoredEntries().find((e) => e.source === 'job' && e.sourceId.startsWith(`${claimed.body.job.id}:`));
    // The worker's claimed $4.20 does not win: the route decides local is $0.
    expect(entry).toMatchObject({ costUsd: 0, costBasis: 'reported', provider: 'local', actorId: 'u-mia', model: 'sonnet' });
  });

  it('never leaks another owner\'s machine or job into the stream', async () => {
    await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const theirs = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
    const app = buildApp({ role: 'member', sub: 'u-mia' });

    const streamed = readStream(app, () => false, { path: '/api/local-compute/events', timeoutMs: 400 });
    await new Promise((r) => setTimeout(r, 50));

    await request(anon()).post('/api/local-compute/announce').set(bearer(theirs.nodeToken))
      .send({ sessions: [{ sessionId: 's-raj' }], metrics: { loadAvg1: 1 } });
    await request(as('member', 'u-raj')).post(`${BASE}/nodes/${theirs.nodeId}/work`)
      .send({ prompt: 'raj private work' });

    const buf = await streamed;
    expect(buf).toContain('mia-mbp');   // her own hello frame arrived
    expect(buf).not.toContain(theirs.nodeId);
    expect(buf).not.toContain('raj-mbp');
    expect(buf).not.toContain('raj private work');
  });
});

// ─── PATCH /nodes/:id — requireAction('ConnectLocalCompute'), owner-scoped ───

describe('PATCH /api/local-compute/nodes/:id', () => {
  it('401s anonymous and 403s a role without ConnectLocalCompute', async () => {
    const anonRes = await request(anon()).patch('/api/local-compute/nodes/node-x').send({ label: 'x' });
    expect(anonRes.status).toBe(401);

    const denied = await request(as('program-owner')).patch('/api/local-compute/nodes/node-x').send({ label: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'Forbidden', action: 'ConnectLocalCompute' });
  });

  it('400s a body that asks for nothing', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    for (const body of [{}, { label: '   ' }, { acceptJobs: 'yes' }]) {
      const res = await request(as('member', 'u-mia')).patch(`/api/local-compute/nodes/${node.nodeId}`).send(body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(res.body).toEqual({ error: 'nothing to update' });
    }
  });

  it('404s an unknown node', async () => {
    const res = await request(as('member', 'u-mia')).patch('/api/local-compute/nodes/node-nope').send({ label: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'node not found' });
  });

  it('404s someone else\'s node — ownership reads as absence, not as Forbidden', async () => {
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
    const res = await request(as('admin', 'u-ops')).patch(`/api/local-compute/nodes/${theirs.nodeId}`).send({ label: 'stolen' });
    // Even an admin: the write is scoped by owner_id in the provider, so
    // holding the capability is not the same as holding the machine.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'node not found' });

    const untouched = await request(as('member', 'u-raj')).get('/api/local-compute/nodes');
    expect(untouched.body.nodes[0].label).toBe('raj-mbp');
  });

  it('renames, truncating to 80 chars, and answers node + presence', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(as('member', 'u-mia')).patch(`/api/local-compute/nodes/${node.nodeId}`)
      .send({ label: `  ${'N'.repeat(120)}  ` });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('N'.repeat(80));
    expect(Object.keys(res.body).sort()).toEqual([
      'acceptJobs', 'createdAt', 'id', 'jobKinds', 'label', 'lastClaimAt', 'lastSeenAt',
      'localModels', 'maxConcurrency', 'ownerId', 'platform', 'presence', 'revokedAt',
    ]);
    expect(res.body.presence).toMatchObject({ nodeId: node.nodeId, status: 'offline', sessions: [] });
  });

  it('toggles acceptJobs, including back to false', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const on = await request(as('member', 'u-mia')).patch(`/api/local-compute/nodes/${node.nodeId}`).send({ acceptJobs: true });
    expect(on.body.acceptJobs).toBe(true);

    // `false` is a meaningful value, not an absent one — a `if (acceptJobs)`
    // check here would make opting back out impossible.
    const off = await request(as('member', 'u-mia')).patch(`/api/local-compute/nodes/${node.nodeId}`).send({ acceptJobs: false });
    expect(off.status).toBe(200);
    expect(off.body.acceptJobs).toBe(false);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes[0].acceptJobs).toBe(false);
  });

  it('applies both fields in one call', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(as('member', 'u-mia')).patch(`/api/local-compute/nodes/${node.nodeId}`)
      .send({ label: 'studio', acceptJobs: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ label: 'studio', acceptJobs: true });
  });
});

// ─── DELETE /nodes/:id — requireAction('ConnectLocalCompute'), owner-scoped ──

describe('DELETE /api/local-compute/nodes/:id', () => {
  it('401s anonymous and 403s a role without ConnectLocalCompute', async () => {
    expect((await request(anon()).delete('/api/local-compute/nodes/node-x')).status).toBe(401);
    const denied = await request(as('program-owner')).delete('/api/local-compute/nodes/node-x');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: 'Forbidden', action: 'ConnectLocalCompute' });
  });

  it('404s an unknown node and someone else\'s node alike', async () => {
    const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
    const unknown = await request(as('member', 'u-mia')).delete('/api/local-compute/nodes/node-nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'node not found' });

    const notMine = await request(as('admin', 'u-ops')).delete(`/api/local-compute/nodes/${theirs.nodeId}`);
    expect(notMine.status).toBe(404);

    const survives = await request(as('member', 'u-raj')).get('/api/local-compute/nodes');
    expect(survives.body.nodes.map((n: { id: string }) => n.id)).toEqual([theirs.nodeId]);
  });

  it('revokes: { ok: true }, gone from the listing, and the token dies with it', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes.map((n: { id: string }) => n.id)).not.toContain(node.nodeId);

    for (const path of ['/api/local-compute/announce', '/api/local-compute/heartbeat', '/api/local-compute/sessions/s-1/end']) {
      const after = await request(anon()).post(path).set(bearer(node.nodeToken)).send({ sessions: [] });
      expect([path, after.status]).toEqual([path, 401]);
    }
  });

  it('a second revoke 404s rather than reviving the row or the token', async () => {
    // Both provider branches carry the same guard now: Aurora's UPDATE has
    // `AND revoked_at IS NULL` (providers/local-compute.ts revokeNode) and the
    // mock's `mockRevokeNode` (mock/local-compute.ts) checks `row.revokedAt`
    // before it stamps — added when the mock moved off the old module-level
    // `Map`s onto a registered `compute-nodes` fixture. A second revoke
    // therefore matches no row on EITHER path and the route 404s both ways,
    // rather than re-stamping `revoked_at` to a later instant.
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    expect((await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`)).status).toBe(200);
    const second = await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`);
    expect(second.status).toBe(404);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes.map((n: { id: string }) => n.id)).not.toContain(node.nodeId);
    const announce = await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [] });
    expect(announce.status).toBe(401);
  });
});

// ─── POST /register — requireNodeToken, self-reported capabilities ────────────
//
// The trust boundary in one block. Everything a machine asserts here can only
// NARROW what it is offered, which is what makes a bearer token sitting on
// somebody's laptop an acceptable credential for this surface: kinds are
// intersected with the server's own allowlist, concurrency is capped by the
// server's own ceiling, and `accept_jobs` is not settable here at all. If any of
// the three ever widens, a stolen node token becomes a way to take work off the
// shared queue.

/** A machine whose owner has switched it on, registered for local:task. */
async function readyWorker(
  opts: { sub?: string; label?: string; maxConcurrency?: number; kinds?: string[] } = {},
): Promise<Paired> {
  const sub = opts.sub ?? 'u-mia';
  const node = await pair({ sub }, { label: opts.label ?? 'mia-mbp' });
  const on = await request(as('member', sub)).patch(`${BASE}/nodes/${node.nodeId}`).send({ acceptJobs: true });
  expect(on.status).toBe(200);
  const reg = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({
    localModels: ['qwen3.6-35b'],
    jobKinds: opts.kinds ?? ['local:task'],
    maxConcurrency: opts.maxConcurrency ?? 2,
  });
  expect(reg.status).toBe(200);
  return node;
}

async function queueLocal(title: string, payload: Record<string, unknown> = {}) {
  const job = await enqueueJob({ kind: 'local:task', title, payload, createdBy: 'u-mia' });
  expect(job).not.toBeNull();
  return job!;
}

describe('POST /api/local-compute/register', () => {
  it('401s with no token, and with a browser session instead of one', async () => {
    expect((await request(anon()).post(`${BASE}/register`).send({})).status).toBe(401);
    expect((await request(as('admin')).post(`${BASE}/register`).send({})).status).toBe(401);
  });

  it('records what the machine advertised and echoes back the owner\'s switch', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({
      localModels: ['qwen3.6-35b', 'nomic-embed'], jobKinds: ['local:task', 'local:distill'], maxConcurrency: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nodeId: node.nodeId,
      label: 'mia-mbp',
      // False, because registering is not opting in. A worker process starting
      // up must not be able to enrol its owner's machine — this is the one field
      // here the machine cannot write, and it is the owner's switch.
      acceptJobs: false,
      localModels: ['qwen3.6-35b', 'nomic-embed'],
      jobKinds: ['local:task', 'local:distill'],
      maxConcurrency: 2,
      // Quoted to the worker rather than left for it to guess: this is the
      // deadline its heartbeat is racing, and the reaper reads the same env var.
      heartbeatIntervalS: 30,
      staleMinutes: 30,
    });
  });

  it('drops a kind local execution does not allow, and SAYS it dropped it', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken))
      .send({ jobKinds: ['local:task', 'devbox:task', 'sudo:make-me-a-sandwich'] });
    expect(res.status).toBe(200);
    expect(res.body.jobKinds).toEqual(['local:task']);
    // Silent narrowing is indistinguishable from an empty queue: a worker that
    // asked for devbox:task and was quietly refused would poll forever and
    // conclude there was no work. `devbox:task` is the one that matters — it is
    // the kind almost everything enqueues today.
    expect(res.body.rejectedKinds).toEqual(['devbox:task', 'sudo:make-me-a-sandwich']);
    expect(res.body.runnableKinds).toEqual(['local:task', 'local:distill', 'local:consolidate']);
  });

  it('orders kinds by the SERVER\'s list, so a node cannot choose what it is offered first', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken))
      .send({ jobKinds: ['local:consolidate', 'local:task', 'local:consolidate'] });
    expect(res.body.jobKinds).toEqual(['local:task', 'local:consolidate']);
  });

  it('caps maxConcurrency at the server ceiling and floors nonsense at 1', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const post = (maxConcurrency: unknown) => request(anon()).post(`${BASE}/register`)
      .set(bearer(node.nodeToken)).send({ jobKinds: ['local:task'], maxConcurrency });

    // The ceiling is the reference workstation's real slot count. A node asking
    // for 64 does not get 64: llama-server queues the overflow rather than
    // failing it, so the extra claims would heartbeat, hold their rows, and blow
    // past the stale window having done nothing — while evicting each other's
    // prompt prefix and making every run on the machine slower.
    expect((await post(64)).body.maxConcurrency).toBe(2);
    expect((await post(1)).body.maxConcurrency).toBe(1);
    for (const bad of [0, -5, 'lots', null, Number.NaN]) {
      expect([bad, (await post(bad)).body.maxConcurrency]).toEqual([bad, 1]);
    }
    // Omitted entirely is the same as unparseable: one job.
    const bare = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({});
    expect(bare.body.maxConcurrency).toBe(1);
  });

  it('treats a garbled advertisement as none rather than 400ing the worker out of the fleet', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    const res = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken))
      .send({ localModels: 'qwen', jobKinds: { local: true } });
    expect(res.status).toBe(200);
    expect(res.body.localModels).toEqual([]);
    expect(res.body.jobKinds).toEqual([]);
  });

  it('is visible to the owner on GET /nodes — registration is durable, not presence', async () => {
    const node = await readyWorker();
    const listed = await request(as('member', 'u-mia')).get(`${BASE}/nodes`);
    const row = listed.body.nodes.find((n: { id: string }) => n.id === node.nodeId);
    expect(row.jobKinds).toEqual(['local:task']);
    expect(row.maxConcurrency).toBe(2);
    expect(row.localModels).toEqual(['qwen3.6-35b']);
    expect(row.acceptJobs).toBe(true);
  });

  it('dies with the token: a revoked machine cannot re-register itself', async () => {
    const node = await readyWorker();
    expect((await request(as('member', 'u-mia')).delete(`${BASE}/nodes/${node.nodeId}`)).status).toBe(200);
    const res = await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken))
      .send({ jobKinds: ['local:task'] });
    expect(res.status).toBe(401);
  });
});

// ─── The work loop: claim → start → heartbeat → complete ─────────────────────

describe('POST /api/local-compute/claim', () => {
  // The claim response frames the prompt as a non-interactive run. Without it
  // a model handed a bare task with an unresolved decision asks a clarifying
  // question, `claude -p` has no stdin to answer from, and the run ends in
  // seconds having done nothing — parked in review carrying a question the
  // review screen cannot answer. Observed on a real run before this landed.
  it('hands the worker a framed prompt, and leaves the stored task alone', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(as('member', 'u-mia')).patch(`${BASE}/nodes/${node.nodeId}`).send({ acceptJobs: true });
    await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({ jobKinds: ['local:task'] });
    const queued = await queueLocal('cutover runbook', { prompt: 'Write the tenant cutover runbook.' });

    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    const prompt = res.body.job.payload.prompt as string;
    expect(prompt).toContain('non-interactively');
    expect(prompt).toContain('Never stop to ask.');
    // The task itself survives verbatim, at the end.
    expect(prompt.endsWith('Write the tenant cutover runbook.')).toBe(true);
    // And the stored row is untouched — the job page shows what a person
    // asked for, not this wrapper.
    const stored = await getJob(queued.id);
    expect(stored!.payload['prompt']).toBe('Write the tenant cutover runbook.');
  });

  it('frames differently depending on whether anyone will review the result', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(as('member', 'u-mia')).patch(`${BASE}/nodes/${node.nodeId}`).send({ acceptJobs: true });
    await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({ jobKinds: ['local:task'] });
    await queueLocal('unreviewed', { prompt: 'Do the thing.', requiresReview: false });

    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.job.payload.prompt).toContain('Nobody will review this before it lands');
    // requiresReview rides through untouched — the worker reads it to decide
    // where the finished job lands.
    expect(res.body.job.payload.requiresReview).toBe(false);
  });

  it('a job carrying no prompt claims unchanged rather than gaining bare framing', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(as('member', 'u-mia')).patch(`${BASE}/nodes/${node.nodeId}`).send({ acceptJobs: true });
    await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({ jobKinds: ['local:task'] });
    await queueLocal('no prompt', { repo: 'https://github.com/x/y' });

    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.job.payload.prompt).toBeUndefined();
    expect(res.body.job.payload.repo).toBe('https://github.com/x/y');
  });

  it('401s every work-loop route with no token, and with a browser session', async () => {
    for (const path of ['/claim', '/jobs/job-1/start', '/jobs/job-1/heartbeat', '/jobs/job-1/complete']) {
      expect([path, (await request(anon()).post(`${BASE}${path}`).send({})).status]).toEqual([path, 401]);
      expect([path, (await request(as('admin')).post(`${BASE}${path}`).send({})).status]).toEqual([path, 401]);
    }
  });

  it('409s a machine whose owner has not switched it on, naming the gate', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({ jobKinds: ['local:task'] });
    await queueLocal('nightly distill');

    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(409);
    // The gate is named because the worker has to know what to DO: this one is
    // "tell your owner to flip a switch", which is not a retry.
    expect(res.body.gate).toBe('accept_jobs');
    expect(res.body.error).toMatch(/not accepting jobs/);
  });

  it('409s a machine that advertised no runnable kind — an empty advertisement is not "everything"', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(as('member', 'u-mia')).patch(`${BASE}/nodes/${node.nodeId}`).send({ acceptJobs: true });
    await queueLocal('nightly distill');

    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('kinds');
  });

  it('204s a quiet queue — polling an empty queue is the common case, not an error', async () => {
    const node = await readyWorker();
    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('never offers a kind the node did not advertise, even when it is the only work queued', async () => {
    const node = await readyWorker({ kinds: ['local:distill'] });
    await queueLocal('a repo task');       // local:task — advertised by nobody here
    expect((await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({})).status).toBe(204);
  });

  it('never offers devbox:task — the queue is full of them and a laptop cannot run one', async () => {
    // The seeded mock queue is entirely devbox:task, and its payload assumes an
    // AgentCore workspace this machine does not have. A node that advertised the
    // kind had it dropped at registration, so there is nothing here to take.
    const node = await readyWorker({ kinds: ['local:task', 'devbox:task'] });
    await enqueueJob({ kind: 'devbox:task', title: 'interactive work', createdBy: 'u-mia' });
    expect((await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({})).status).toBe(204);
  });

  it('hands out the job, a fencing token and ONE session id, and marks the row claimed', async () => {
    const node = await readyWorker();
    const queued = await queueLocal('nightly distill', { repo: 'aws-agentcore', prompt: 'distil' });

    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(queued.id);
    // Everything in the payload rides through untouched EXCEPT the prompt,
    // which is framed as a non-interactive run on the way out (see
    // `frameLocalPrompt`). The task itself is still the tail of it.
    expect(res.body.job.payload.repo).toBe('aws-agentcore');
    expect(res.body.job.payload.prompt.endsWith('distil')).toBe(true);
    expect(res.body.job.payload.prompt).toContain('Never stop to ask.');
    expect(res.body.claimToken).toMatch(/^clm_[0-9a-f]{32}$/);
    expect(res.body.heartbeatIntervalS).toBe(30);
    expect(res.body.staleMinutes).toBe(30);
    expect(res.body.slots).toEqual({ held: 1, limit: 2 });
    // One id for the queue row AND the presence session, so the fleet view can
    // join a running local job to the machine session showing it. Two
    // independently invented ids could not be joined at all.
    expect(res.body.sessionId).toContain(node.nodeId);

    const row = await getJob(queued.id);
    expect(row!.status).toBe('claimed');
    expect(row!.boxId).toBe(`local:${node.nodeId}`);
    expect(row!.sessionId).toBe(res.body.sessionId);
    expect(row!.attempts).toBe(1);
  });

  it('does not hand the fencing token back on a later read — only the holder has it', async () => {
    const node = await readyWorker();
    const queued = await queueLocal('nightly distill');
    const claim = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(claim.body.claimToken).toBeTruthy();
    // The claim response is the one and only delivery. A worker that loses it
    // has lost the claim, which is the property the fence depends on.
    expect(JSON.stringify(await getJob(queued.id))).not.toContain(claim.body.claimToken);
  });

  it('429s at the node\'s own slot limit, and the limit is counted from the ROWS', async () => {
    const node = await readyWorker({ maxConcurrency: 2 });
    await queueLocal('one');
    await queueLocal('two');
    await queueLocal('three');

    const first = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    const second = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.slots).toEqual({ held: 2, limit: 2 });

    const third = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(third.status).toBe(429);
    expect(third.body.gate).toBe('concurrency');
    // Told apart from the per-IP rate limiter, which answers the SAME status and
    // means the opposite thing. The limiter sends `bucket`; the brake sends
    // `gate`. A worker cannot distinguish "slow down" from "you are full" by
    // status code alone, and the two want different responses.
    expect(third.body).not.toHaveProperty('bucket');

    // Finishing one frees exactly one slot — the count comes from the rows, not
    // from whatever the worker believes it is running, so a worker that crashed
    // and forgot its claims still cannot exceed its cap.
    await request(anon()).post(`${BASE}/jobs/${first.body.job.id}/complete`).set(bearer(node.nodeToken))
      .send({ claimToken: first.body.claimToken, status: 'done' });
    expect((await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({})).status).toBe(200);
  });

  it('gives two machines different jobs — the claim is atomic, not read-then-write', async () => {
    const mia = await readyWorker({ sub: 'u-mia', label: 'mia-mbp' });
    const raj = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
    await queueLocal('one');
    await queueLocal('two');

    const a = await request(anon()).post(`${BASE}/claim`).set(bearer(mia.nodeToken)).send({});
    const b = await request(anon()).post(`${BASE}/claim`).set(bearer(raj.nodeToken)).send({});
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.job.id).not.toBe(b.body.job.id);
    expect(a.body.claimToken).not.toBe(b.body.claimToken);
  });
});

describe('the fenced job writes', () => {
  async function claimed(opts: { sub?: string; label?: string } = {}) {
    const node = await readyWorker(opts);
    await queueLocal('nightly distill');
    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    return { node, jobId: res.body.job.id as string, claimToken: res.body.claimToken as string };
  }

  const paths = (jobId: string) => [
    `/jobs/${jobId}/start`, `/jobs/${jobId}/heartbeat`, `/jobs/${jobId}/complete`,
  ];

  it('400s every fenced write with no claimToken — it was returned once, by the claim', async () => {
    const held = await claimed();
    for (const path of paths(held.jobId)) {
      const res = await request(anon()).post(`${BASE}${path}`).set(bearer(held.node.nodeToken)).send({ status: 'done' });
      expect([path, res.status]).toEqual([path, 400]);
      expect(res.body.error).toMatch(/claimToken is required/);
    }
    expect((await getJob(held.jobId))!.status).toBe('claimed');
  });

  it('404s a job this machine does not hold, and says nothing about whose it is', async () => {
    const mine = await claimed({ sub: 'u-mia', label: 'mia-mbp' });
    const theirs = await claimed({ sub: 'u-raj', label: 'raj-mbp' });

    for (const path of paths(theirs.jobId)) {
      // Mia's token against Raj's job — carrying Raj's REAL claim token, so this
      // is the ownership check doing the work rather than the fence. A 409 here
      // would confirm that somebody else's job exists.
      const res = await request(anon()).post(`${BASE}${path}`).set(bearer(mine.node.nodeToken))
        .send({ claimToken: theirs.claimToken, status: 'done' });
      expect([path, res.status]).toEqual([path, 404]);
      expect(res.body).toEqual({ error: 'no such claim on this machine' });
    }
    for (const path of paths('job-does-not-exist')) {
      const res = await request(anon()).post(`${BASE}${path}`).set(bearer(mine.node.nodeToken))
        .send({ claimToken: mine.claimToken, status: 'done' });
      // Identical body for "not yours" and "not there", so a node cannot probe
      // the queue for ids it does not hold.
      expect([path, res.body.error]).toEqual([path, 'no such claim on this machine']);
    }
    expect((await getJob(theirs.jobId))!.status).toBe('claimed');
  });

  it('409s a fenced write carrying the wrong token, without touching the row', async () => {
    const held = await claimed();
    for (const path of paths(held.jobId)) {
      const res = await request(anon()).post(`${BASE}${path}`).set(bearer(held.node.nodeToken))
        .send({ claimToken: 'clm_deadbeef', status: 'done' });
      expect([path, res.status]).toEqual([path, 409]);
      expect(res.body.gate).toBe('claim_lost');
    }
    expect((await getJob(held.jobId))!.status).toBe('claimed');
  });

  it('runs the loop: start → heartbeat → complete', async () => {
    const held = await claimed();
    const fenced = (path: string, body: Record<string, unknown> = {}) => request(anon())
      .post(`${BASE}${path}`).set(bearer(held.node.nodeToken)).send({ claimToken: held.claimToken, ...body });

    const started = await fenced(`/jobs/${held.jobId}/start`);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ ok: true, jobId: held.jobId });
    expect((await getJob(held.jobId))!.status).toBe('running');

    const beat = await fenced(`/jobs/${held.jobId}/heartbeat`);
    expect(beat.status).toBe(200);
    expect(beat.body).toEqual({ ok: true, jobId: held.jobId });
    // A machine mid-job is the most alive it ever is. The heartbeat moves node
    // presence too, or the fleet view shows a running job on an offline machine.
    const listed = await request(as('member', 'u-mia')).get(`${BASE}/nodes`);
    const row = listed.body.nodes.find((n: { id: string }) => n.id === held.node.nodeId);
    expect(Date.parse(row.lastSeenAt)).not.toBeNaN();

    const done = await fenced(`/jobs/${held.jobId}/complete`, { status: 'awaiting_review' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({
      ok: true, jobId: held.jobId, status: 'awaiting_review', costUsd: 0, provider: 'local',
    });
    expect((await getJob(held.jobId))!.status).toBe('awaiting_review');
  });

  it('400s a completion with no usable status — the write that ends a job gets no default', async () => {
    const held = await claimed();
    for (const status of [undefined, 'finished', 'queued', 'running', 42]) {
      const res = await request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
        .set(bearer(held.node.nodeToken)).send({ claimToken: held.claimToken, status });
      expect([status, res.status]).toEqual([status, 400]);
      expect(res.body.error).toMatch(/status must be one of/);
    }
    // Guessing 'done' for a worker that forgot the field would record a success
    // nobody claimed — the same shape as the `subtype: success` producer bug.
    expect((await getJob(held.jobId))!.status).toBe('claimed');
  });

  it('prices a local run at a confident 0 and keeps what the run CLAIMED beside it', async () => {
    const held = await claimed();
    const res = await request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
      .set(bearer(held.node.nodeToken)).send({
        claimToken: held.claimToken, status: 'done',
        // The measured lie: Claude Code 2.1.236 reports first-party Sonnet list
        // price for tokens generated on loopback. 0.003711 is the figure a real
        // run against llama-server on 127.0.0.1 came back with.
        costUsd: 0.003711,
        model: 'claude-sonnet-4-5-20250929', tokensIn: 1227, tokensOut: 2,
        result: { summary: 'distilled 14 notes' },
      });
    expect(res.status).toBe(200);

    const row = await getJob(held.jobId);
    expect(row!.result).toMatchObject({
      provider: 'local',
      costUsd: 0,
      reportedCostUsd: 0.003711,
      // The override is auditable rather than silent: $0 with no explanation,
      // beside a run that reported otherwise, is indistinguishable from a bug.
      costNote: 'run reported $0.003711; recorded $0 — served by local inference',
      summary: 'distilled 14 notes',
      nodeId: held.node.nodeId,
      nodeLabel: 'mia-mbp',
      // The model id is recorded and is NOT evidence of who served the run:
      // Claude Code rejects an unknown --model client-side, so a local run must
      // send a real Anthropic id that llama.cpp then ignores. `provider` is the
      // only field that answers "where did this actually run".
      model: 'claude-sonnet-4-5-20250929',
      tokensIn: 1227, tokensOut: 2,
    });
  });

  it('leaves reportedCostUsd ABSENT when the run claimed nothing, rather than writing 0', async () => {
    // The other half of run-cost.ts's doctrine. For a local run the recorded 0
    // is a confident zero, so there is nothing to be unknown about — but the
    // claimed figure is a separate fact, and "the run reported $0" is not the
    // same statement as "the run reported nothing". Writing 0 into the field
    // would invent the first from the second.
    const held = await claimed();
    await request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
      .set(bearer(held.node.nodeToken)).send({ claimToken: held.claimToken, status: 'done' });
    const row = await getJob(held.jobId);
    expect(row!.result).toMatchObject({ provider: 'local', costUsd: 0 });
    expect(row!.result).not.toHaveProperty('reportedCostUsd');
    expect(row!.result).not.toHaveProperty('costNote');
  });

  it('will not let the machine name its own provider or price — this is a trust boundary', async () => {
    const held = await claimed();
    await request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
      .set(bearer(held.node.nodeToken)).send({
        claimToken: held.claimToken, status: 'done',
        // A laptop asserting Bedrock spend would bill an initiative's allocation
        // and an SME's sprint envelope for money nobody spent. `provider` is
        // set by which ROUTE the completion arrived on, never by the body.
        result: { provider: 'bedrock', costUsd: 4.2, nodeId: 'somebody-else' },
      });
    const row = await getJob(held.jobId);
    expect(row!.result).toMatchObject({ provider: 'local', costUsd: 0, nodeId: held.node.nodeId });
  });

  it('records a failure with its error text, and prices it the same', async () => {
    const held = await claimed();
    const res = await request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
      .set(bearer(held.node.nodeToken)).send({
        claimToken: held.claimToken, status: 'failed',
        error: 'llama-server was not listening on 127.0.0.1:8080',
      });
    expect(res.status).toBe(200);
    const row = await getJob(held.jobId);
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('llama-server was not listening on 127.0.0.1:8080');
    // A failed run still ran, and still ran locally — the provenance is not
    // conditional on the outcome.
    expect(row!.result).toMatchObject({ provider: 'local', costUsd: 0 });
  });

  it('is once-only: the same completion POSTed twice does not double-write', async () => {
    const held = await claimed();
    const send = (summary: string) => request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
      .set(bearer(held.node.nodeToken))
      .send({ claimToken: held.claimToken, status: 'done', result: { summary } });

    expect((await send('first')).status).toBe(200);
    const second = await send('second');
    // Completing clears the token, so a worker retrying after a network blip
    // cannot overwrite the result it already wrote — and neither can a late
    // completion from a claim the reaper has since requeued and re-run.
    expect(second.status).toBe(409);
    expect(second.body.gate).toBe('claim_lost');
    expect((await getJob(held.jobId))!.result).toMatchObject({ summary: 'first' });
  });

  it('ends the presence session the claim minted, so a finished job leaves no ghost', async () => {
    const node = await readyWorker();
    await queueLocal('nightly distill');
    const claim = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    const sessionId = claim.body.sessionId as string;

    // The worker announces the session the SERVER minted, which is the whole
    // reason the claim returns one instead of letting both sides invent their own.
    await request(anon()).post(`${BASE}/announce`).set(bearer(node.nodeToken))
      .send({ sessions: [{ sessionId, harness: 'claude-code', intent: 'nightly distill' }] });
    const during = await request(as('member', 'u-mia')).get(`${BASE}/nodes`);
    expect(during.body.nodes[0].presence.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([sessionId]);

    await request(anon()).post(`${BASE}/jobs/${claim.body.job.id}/complete`).set(bearer(node.nodeToken))
      .send({ claimToken: claim.body.claimToken, status: 'done' });

    const after = await request(as('member', 'u-mia')).get(`${BASE}/nodes`);
    expect(after.body.nodes[0].presence.sessions).toEqual([]);
  });

  it('stops the whole loop the moment the owner revokes the machine', async () => {
    const held = await claimed();
    expect((await request(as('member', 'u-mia')).delete(`${BASE}/nodes/${held.node.nodeId}`)).status).toBe(200);
    for (const path of ['/claim', ...paths(held.jobId)]) {
      const res = await request(anon()).post(`${BASE}${path}`).set(bearer(held.node.nodeToken))
        .send({ claimToken: held.claimToken, status: 'done' });
      expect([path, res.status]).toEqual([path, 401]);
    }
    // The job it was holding is left for the reaper rather than silently
    // finished or failed: revoking a credential says nothing about the work's
    // outcome, and the run may well still be going on that machine.
    expect((await getJob(held.jobId))!.status).toBe('claimed');
  });
});

// Handing a machine work, and reading back what it did.
//
// The control that makes a CONNECTED machine a fleet participant rather than a
// status light. Two properties are load-bearing and neither is visible from the
// happy path: the dispatch gates are the SAME ones the claim would hit (so
// queueing into a switched-off machine is refused at the door instead of
// producing a row nothing will ever claim), and a dispatched job is TARGETED —
// claimable by exactly the machine it was handed to. Without targeting the local
// pull queue is global, and "run this on my laptop" puts the prompt text on
// whichever paired machine wins the race, including someone else's.
describe('handing a machine work', () => {
  const workPath = (nodeId: string) => `${BASE}/nodes/${nodeId}/work`;

  const hand = (
    app: express.Express, nodeId: string, body: Record<string, unknown> = {},
  ) => request(app).post(workPath(nodeId)).send({ prompt: 'distill yesterday', ...body });

  describe('POST /nodes/:nodeId/work', () => {
    it('401s a cookie-less caller and a node token — dispatching is a person, not a machine', async () => {
      const node = await readyWorker();
      expect((await hand(anon(), node.nodeId)).status).toBe(401);
      const withToken = await request(anon()).post(workPath(node.nodeId))
        .set(bearer(node.nodeToken)).send({ prompt: 'x' });
      expect(withToken.status).toBe(401);
    });

    it('403s a role without ConnectLocalCompute — the same gate that pairs a machine', async () => {
      const node = await readyWorker({ sub: 'u-mia' });
      // Same person, a role whose Cedar seed does not list the capability. The
      // capability is checked before ownership, so this is a 403 and not a 404.
      const res = await hand(as('program-owner', 'u-mia'), node.nodeId);
      expect(res.status).toBe(403);
    });

    it("404s somebody else's machine, and says nothing about whose it is", async () => {
      const theirs = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
      const res = await hand(as('member', 'u-mia'), theirs.nodeId);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'node not found' });
      // Identical body for a machine that does not exist at all.
      const missing = await hand(as('member', 'u-mia'), 'node-nope');
      expect(missing.body).toEqual({ error: 'node not found' });
    });

    it('400s an empty prompt and a kind local execution does not allow', async () => {
      const node = await readyWorker();
      const app = as('member', 'u-mia');
      for (const prompt of [undefined, '', '   ']) {
        const res = await request(app).post(workPath(node.nodeId)).send({ prompt });
        expect([prompt, res.status]).toEqual([prompt, 400]);
        expect(res.body.error).toMatch(/prompt is required/);
      }
      // `devbox:task` is the kind almost everything enqueues and the one a laptop
      // must never be handed — it assumes an AgentCore workspace, and somebody
      // may be tailing a stream that a local claim would never produce.
      const wrongKind = await hand(app, node.nodeId, { kind: 'devbox:task' });
      expect(wrongKind.status).toBe(400);
      expect(wrongKind.body.error).toMatch(/kind must be one of local:task/);
    });

    it('409s a machine that is switched off, naming the gate rather than queueing into a void', async () => {
      const node = await readyWorker();
      expect((await request(as('member', 'u-mia')).patch(`${BASE}/nodes/${node.nodeId}`)
        .send({ acceptJobs: false })).status).toBe(200);

      const res = await hand(as('member', 'u-mia'), node.nodeId);
      expect(res.status).toBe(409);
      expect(res.body.gate).toBe('accept_jobs');
      // The refusal has to happen HERE. Accepting it would write a queued row
      // that the claim route then declines to hand out forever, with nothing on
      // any page saying why the machine never picked it up.
      expect((await request(as('member', 'u-mia')).get(`${BASE}/runs`)).body.runs).toEqual([]);
    });

    it('409s a kind the machine never registered for, and names what it does run', async () => {
      const node = await readyWorker({ kinds: ['local:distill'] });
      const res = await hand(as('member', 'u-mia'), node.nodeId, { kind: 'local:task' });
      expect(res.status).toBe(409);
      expect(res.body.gate).toBe('kinds');
      expect(res.body.error).toMatch(/runs local:distill/);
    });

    it('queues the job TARGETED at that machine, with the repo and the review flag', async () => {
      const node = await readyWorker();
      const res = await hand(as('member', 'u-mia'), node.nodeId, {
        title: 'nightly distill', repo: 'git@github.com:acme/api.git',
      });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe('local:task');
      expect(res.body.title).toBe('nightly distill');
      expect(res.body.status).toBe('queued');

      const row = await getJob(res.body.id);
      expect(row!.payload).toMatchObject({
        prompt: 'distill yesterday',
        // The whole point: without this the row is claimable by any paired
        // machine registered for the kind.
        nodeId: node.nodeId,
        repo: 'git@github.com:acme/api.git',
        // A repo means a change someone can accept or reject — reviewed.
        requiresReview: true,
      });
      // Attribution comes from the session, never the body.
      expect(row!.createdBy).toBe('u-mia');
    });

    it('does not park a run with no repo in review — there is no capture to look at', async () => {
      const node = await readyWorker();
      const res = await hand(as('member', 'u-mia'), node.nodeId, { prompt: 'what is 10+10' });
      expect(res.status).toBe(201);
      const row = await getJob(res.body.id);
      expect(row!.payload).toMatchObject({ requiresReview: false });
      // …unless the caller asks for a look anyway.
      const asked = await hand(as('member', 'u-mia'), node.nodeId, { prompt: 'summarise', requiresReview: true });
      expect((await getJob(asked.body.id))!.payload).toMatchObject({ requiresReview: true });
    });

    it('does not hand a work item to an SME machine when authoritative grant access is unavailable', async () => {
      const node = await readyWorker({ sub: 'u-nora', label: 'nora-audit' });
      const before = await listJobs({ limit: 1_000 });
      const unavailable = jest.spyOn(budgets, 'listGrants').mockRejectedValueOnce(new Error('grant database unavailable'));
      try {
        const res = await hand(as('sme', 'u-nora'), node.nodeId, { workItemId: 'wi-auth-e2' });
        expect(res.status).toBe(503);
        expect(res.body.gate).toBe('grant-authorization');
        expect(await listJobs({ limit: 1_000 })).toEqual(before);
      } finally { unavailable.mockRestore(); }
    });

    it('hands a machine an initiative work item — title, prompt and origin from the item, no typed prompt', async () => {
      const node = await readyWorker();
      const res = await hand(as('member', 'u-mia'), node.nodeId, { workItemId: 'wi-auth-e2' });
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe('local:task');
      const row = await getJob(res.body.id);
      // The helper types a prompt (as the old composer did); the item still
      // names the row and travels with it so the run can be traced back.
      expect(row!.title).toBe('Legacy SSO decommission');
      expect(row!.payload).toMatchObject({ nodeId: node.nodeId, workItemId: 'wi-auth-e2', initiativeId: 'p-auth-migration' });
    });

    it('404s an unknown work item and refuses a bot to a role without ManageBots', async () => {
      const node = await readyWorker();
      expect((await hand(as('member', 'u-mia'), node.nodeId, { workItemId: 'wi-nope' })).status).toBe(404);
      expect((await hand(as('member', 'u-mia'), node.nodeId, { botId: 'nope' })).status).toBe(404);
    });

    it('titles an untitled job from its prompt rather than leaving a blank row', async () => {
      const node = await readyWorker();
      const res = await hand(as('member', 'u-mia'), node.nodeId, { prompt: 'summarise the ADRs' });
      expect(res.body.title).toBe('summarise the ADRs');
    });

    it('omits repo when none was given, rather than writing an empty string', async () => {
      const node = await readyWorker();
      const res = await hand(as('member', 'u-mia'), node.nodeId, { repo: '   ' });
      const row = await getJob(res.body.id);
      expect(row!.payload).not.toHaveProperty('repo');
    });
  });

  describe('the targeting the dispatch writes', () => {
    it('will not let another machine claim work handed to this one', async () => {
      const mine = await readyWorker({ sub: 'u-mia', label: 'mia-mbp' });
      const theirs = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
      const handed = await hand(as('member', 'u-mia'), mine.nodeId, { title: 'mine alone' });
      expect(handed.status).toBe(201);

      // Raj's machine is registered for the same kind and polls the same queue.
      const stolen = await request(anon()).post(`${BASE}/claim`).set(bearer(theirs.nodeToken)).send({});
      expect(stolen.status).toBe(204);
      expect((await getJob(handed.body.id))!.status).toBe('queued');

      // The machine it was handed to gets it.
      const claimed = await request(anon()).post(`${BASE}/claim`).set(bearer(mine.nodeToken)).send({});
      expect(claimed.status).toBe(200);
      expect(claimed.body.job.id).toBe(handed.body.id);
    });

    it('leaves an untargeted local job claimable by any eligible machine', async () => {
      // The pre-existing contract, and the reason targeting is a payload field
      // rather than a schema change: a script or a bot that enqueues local work
      // without naming a machine still gets whichever one is free.
      const other = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
      const job = await queueLocal('anyone can take this');
      const claimed = await request(anon()).post(`${BASE}/claim`).set(bearer(other.nodeToken)).send({});
      expect(claimed.status).toBe(200);
      expect(claimed.body.job.id).toBe(job.id);
    });
  });

  describe('GET /runs', () => {
    it('401s a cookie-less caller and a node token', async () => {
      const node = await readyWorker();
      expect((await request(anon()).get(`${BASE}/runs`)).status).toBe(401);
      expect((await request(anon()).get(`${BASE}/runs`).set(bearer(node.nodeToken))).status).toBe(401);
    });

    it('shows a run the moment it is queued, before any machine has claimed it', async () => {
      // A queued row has no box_id yet, so matching on box alone would hide work
      // for exactly as long as somebody is standing there watching for it.
      const node = await readyWorker();
      const handed = await hand(as('member', 'u-mia'), node.nodeId, { title: 'nightly distill' });
      const res = await request(as('member', 'u-mia')).get(`${BASE}/runs`);
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0]).toMatchObject({
        id: handed.body.id, title: 'nightly distill', status: 'queued',
        // Resolved server-side: `local:` prefixing is the router's convention
        // and not something the browser should have to slice off a box id.
        nodeId: node.nodeId, nodeLabel: 'mia-mbp',
      });
    });

    it('follows the run through claim and completion, keeping the local $0', async () => {
      const node = await readyWorker();
      const handed = await hand(as('member', 'u-mia'), node.nodeId);
      const claim = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
      expect(claim.body.job.id).toBe(handed.body.id);
      await request(anon()).post(`${BASE}/jobs/${handed.body.id}/complete`)
        .set(bearer(node.nodeToken)).send({
          claimToken: claim.body.claimToken, status: 'awaiting_review',
          costUsd: 0.0172, result: { summary: 'distilled 14 notes' },
        });

      const res = await request(as('member', 'u-mia')).get(`${BASE}/runs`);
      expect(res.body.runs[0]).toMatchObject({
        id: handed.body.id, status: 'awaiting_review', nodeLabel: 'mia-mbp',
      });
      expect(res.body.runs[0].result).toMatchObject({ provider: 'local', costUsd: 0 });
    });

    it("never shows another person's runs, not even to a fleet-wide role", async () => {
      const theirs = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
      await hand(as('member', 'u-raj'), theirs.nodeId, { title: 'raj private work' });

      // A run's prompt, repo and output are a person's work. /nodes/all is where
      // a leader learns that machines exist; it is not a way into their content.
      for (const role of ['member', 'org-leader', 'hr-admin'] as const) {
        const res = await request(as(role, 'u-mia')).get(`${BASE}/runs`);
        expect([role, res.status]).toEqual([role, 200]);
        expect([role, res.body.runs]).toEqual([role, []]);
      }
    });

    it('returns an empty list for a person with no machines at all', async () => {
      const res = await request(as('member', 'u-nobody')).get(`${BASE}/runs`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ runs: [] });
    });
  });
});

// The run logs a machine ships while it works, and the browser view that tails
// them. Two halves with opposite floors: ingest is a fenced node-token callback
// (a browser cannot write a run's log), the reads are owner-scoped browser
// routes (a node token cannot read one, and a fleet-wide role sees only its own
// machines' runs — a run's output is a person's work).
describe('the run logs', () => {
  async function claimed(opts: { sub?: string; label?: string } = {}) {
    const node = await readyWorker(opts);
    await queueLocal('nightly distill');
    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(res.status).toBe(200);
    return { node, jobId: res.body.job.id as string, claimToken: res.body.claimToken as string };
  }

  const ship = (held: { node: Paired; jobId: string; claimToken: string }, body: Record<string, unknown>) =>
    request(anon()).post(`${BASE}/jobs/${held.jobId}/log`).set(bearer(held.node.nodeToken))
      .send({ claimToken: held.claimToken, ...body });

  describe('POST /jobs/:jobId/log (ingest — node token, fenced)', () => {
    it('401s a browser session — a cookie cannot write a machine log', async () => {
      const held = await claimed();
      const res = await request(as('member', 'u-mia')).post(`${BASE}/jobs/${held.jobId}/log`)
        .send({ claimToken: held.claimToken, seq: 0, chunk: 'hi' });
      expect(res.status).toBe(401);
    });

    it('400s with no claimToken, and 404s a job this machine does not hold', async () => {
      const held = await claimed();
      const noToken = await request(anon()).post(`${BASE}/jobs/${held.jobId}/log`)
        .set(bearer(held.node.nodeToken)).send({ seq: 0, chunk: 'hi' });
      expect(noToken.status).toBe(400);
      expect(noToken.body.error).toMatch(/claimToken is required/);

      const notHeld = await request(anon()).post(`${BASE}/jobs/job-nope/log`)
        .set(bearer(held.node.nodeToken)).send({ claimToken: held.claimToken, seq: 0, chunk: 'hi' });
      expect(notHeld.status).toBe(404);
      expect(notHeld.body).toEqual({ error: 'no such claim on this machine' });
    });

    it('400s a chunk that is missing or not a non-empty string, and a bad seq', async () => {
      const held = await claimed();
      for (const chunk of [undefined, '', 42, {}]) {
        const res = await ship(held, { seq: 0, chunk });
        expect([chunk, res.status]).toEqual([chunk, 400]);
        expect(res.body.error).toMatch(/chunk must be a non-empty string/);
      }
      for (const seq of [undefined, -1, 'x']) {
        const res = await ship(held, { seq, chunk: 'hi' });
        expect([seq, res.status]).toEqual([seq, 400]);
        expect(res.body.error).toMatch(/seq must be a non-negative number/);
      }
    });

    it('appends chunks the owner can then read back, in arrival order', async () => {
      const held = await claimed();
      expect((await ship(held, { seq: 0, chunk: 'first line\n' })).status).toBe(200);
      expect((await ship(held, { seq: 1, chunk: 'second line\n' })).status).toBe(200);

      const view = await request(as('member', 'u-mia')).get(`${BASE}/jobs/${held.jobId}/log`);
      expect(view.status).toBe(200);
      expect(view.body.jobId).toBe(held.jobId);
      expect(view.body.done).toBe(false);
      expect(view.body.lastSeq).toBe(1);
      expect(view.body.entries.map((e: { seq: number; text: string }) => [e.seq, e.text]))
        .toEqual([[0, 'first line\n'], [1, 'second line\n']]);
    });

    it('is idempotent on seq — a re-shipped chunk is dropped, not duplicated', async () => {
      const held = await claimed();
      await ship(held, { seq: 0, chunk: 'once\n' });
      await ship(held, { seq: 0, chunk: 'once\n' });
      const view = await request(as('member', 'u-mia')).get(`${BASE}/jobs/${held.jobId}/log`);
      expect(view.body.entries).toHaveLength(1);
    });

    it('marks the log done when the job completes, so a tailer stops polling', async () => {
      const held = await claimed();
      await ship(held, { seq: 0, chunk: 'working\n' });
      await request(anon()).post(`${BASE}/jobs/${held.jobId}/complete`)
        .set(bearer(held.node.nodeToken)).send({ claimToken: held.claimToken, status: 'done' });
      const view = await request(as('member', 'u-mia')).get(`${BASE}/jobs/${held.jobId}/log`);
      expect(view.body.done).toBe(true);
    });
  });

  describe('GET /jobs/:jobId/log (read — browser, owner-scoped)', () => {
    it('401s a cookie-less caller and a node token — the read side is a browser floor', async () => {
      const held = await claimed();
      await ship(held, { seq: 0, chunk: 'hi\n' });

      expect((await request(anon()).get(`${BASE}/jobs/${held.jobId}/log`)).status).toBe(401);
      const withToken = await request(anon()).get(`${BASE}/jobs/${held.jobId}/log`).set(bearer(held.node.nodeToken));
      expect(withToken.status).toBe(401);
    });

    it('404s a run on a machine the caller does not own, and says nothing about whose it is', async () => {
      const mine = await claimed({ sub: 'u-mia', label: 'mia-mbp' });
      const theirs = await claimed({ sub: 'u-raj', label: 'raj-mbp' });
      await ship(theirs, { seq: 0, chunk: 'secret\n' });

      const res = await request(as('member', 'u-mia')).get(`${BASE}/jobs/${theirs.jobId}/log`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'no such run log' });

      // Same body for a job that does not exist at all, so a browser cannot probe.
      const missing = await request(as('member', 'u-mia')).get(`${BASE}/jobs/job-nope/log`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: 'no such run log' });

      // The owner still reads their own run fine.
      expect((await request(as('member', 'u-mia')).get(`${BASE}/jobs/${mine.jobId}/log`)).status).toBe(200);
    });

    it('returns the empty shape for a claimed run that has shipped nothing yet', async () => {
      const held = await claimed();
      const res = await request(as('member', 'u-mia')).get(`${BASE}/jobs/${held.jobId}/log`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        jobId: held.jobId, entries: [], lastSeq: -1, bytes: 0, updatedAt: null, done: false,
      });
    });

    it('honours ?since to return only chunks after a poller cursor', async () => {
      const held = await claimed();
      await ship(held, { seq: 0, chunk: 'a\n' });
      await ship(held, { seq: 1, chunk: 'b\n' });
      await ship(held, { seq: 2, chunk: 'c\n' });

      const res = await request(as('member', 'u-mia')).get(`${BASE}/jobs/${held.jobId}/log`).query({ since: 1 });
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: { seq: number }) => e.seq)).toEqual([2]);
      expect(res.body.lastSeq).toBe(2);
    });
  });

  describe('GET /jobs/:jobId/log/stream (tail — browser, owner-scoped)', () => {
    it('401s a cookie-less caller', async () => {
      const held = await claimed();
      const res = await request(anon()).get(`${BASE}/jobs/${held.jobId}/log/stream`);
      expect(res.status).toBe(401);
    });

    it('replays the backlog then pushes a live chunk over SSE', async () => {
      const held = await claimed();
      await ship(held, { seq: 0, chunk: 'backlog\n' });

      const streamPath = `${BASE}/jobs/${held.jobId}/log/stream`;
      const app = as('member', 'u-mia');
      const streamed = readStream(app, (buf) => buf.includes('live'), { path: streamPath, timeoutMs: 5000 });

      // Give the stream a tick to open and replay before shipping the live chunk.
      await new Promise((r) => setTimeout(r, 100));
      await ship(held, { seq: 1, chunk: 'live\n' });

      const body = await streamed;
      expect(body).toContain('backlog');
      expect(body).toContain('live');
    });
  });
});

// ─── The node operational log ────────────────────────────────────────────────
//
// What the worker ships BETWEEN jobs — presence checks, "paused, waiting for
// accept-jobs", claim refusals — as distinct from a single run's stdout
// above. Ingest is a bare node-token callback (no claim to fence with, since
// these lines exist outside any claim); the read side is owner-scoped exactly
// like the run log, for the same reason: this is a person's own machine
// talking about its own work.
describe('the node operational log', () => {
  const shipLines = (nodeToken: string, lines: Array<{ seq: number; text: string }>) =>
    request(anon()).post(`${BASE}/log`).set(bearer(nodeToken)).send({ lines });

  describe('POST /log (ingest — node token, no claim)', () => {
    it('401s a browser session and a cookie-less caller — only a node token may ship this', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      expect((await request(as('member', 'u-mia')).post(`${BASE}/log`).send({ lines: [{ seq: 0, text: 'hi' }] })).status).toBe(401);
      expect((await request(anon()).post(`${BASE}/log`).send({ lines: [{ seq: 0, text: 'hi' }] })).status).toBe(401);
      expect((await shipLines(node.nodeToken, [{ seq: 0, text: 'registered\n' }])).status).toBe(200);
    });

    it('400s a malformed body: not an array, empty, too many lines, or a bad entry', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      for (const lines of [undefined, 'nope', [], Array.from({ length: 51 }, (_, i) => ({ seq: i, text: 'x' }))]) {
        const res = await request(anon()).post(`${BASE}/log`).set(bearer(node.nodeToken)).send({ lines });
        expect([lines, res.status]).toEqual([lines, 400]);
      }
      for (const bad of [{ seq: -1, text: 'x' }, { seq: 'x', text: 'x' }, { seq: 0, text: '' }, { seq: 0, text: 42 }, {}]) {
        const res = await shipLines(node.nodeToken, [bad as { seq: number; text: string }]);
        expect([bad, res.status]).toEqual([bad, 400]);
      }
    });

    it('appends every line in one batch, readable back by the owner', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      const res = await shipLines(node.nodeToken, [
        { seq: 0, text: '12:00:00 · registered\n' },
        { seq: 1, text: '12:00:01 ✓ presence acknowledged\n' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, nodeId: node.nodeId, lines: 2 });

      const view = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${node.nodeId}/log`);
      expect(view.status).toBe(200);
      expect(view.body.nodeId).toBe(node.nodeId);
      expect(view.body.lastSeq).toBe(1);
      expect(view.body.entries.map((e: { seq: number; text: string }) => [e.seq, e.text])).toEqual([
        [0, '12:00:00 · registered\n'],
        [1, '12:00:01 ✓ presence acknowledged\n'],
      ]);
    });

    it('is idempotent on seq — a re-shipped batch does not duplicate lines', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      await shipLines(node.nodeToken, [{ seq: 0, text: 'once\n' }]);
      await shipLines(node.nodeToken, [{ seq: 0, text: 'once\n' }]);
      const view = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${node.nodeId}/log`);
      expect(view.body.entries).toHaveLength(1);
    });

    it('a claim refusal does not stop the machine from shipping its log — no claim token required', async () => {
      // Not fenced: unlike jobs/:id/log, there is no active claim between jobs,
      // and the whole point of this route is to carry lines from exactly that
      // gap. A node token alone is the complete credential.
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      const res = await shipLines(node.nodeToken, [{ seq: 0, text: 'paused: not accepting jobs\n' }]);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /nodes/:id/log (read — browser, owner-scoped)', () => {
    it('401s a cookie-less caller and a node token — the read side is a browser floor', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      await shipLines(node.nodeToken, [{ seq: 0, text: 'hi\n' }]);
      expect((await request(anon()).get(`${BASE}/nodes/${node.nodeId}/log`)).status).toBe(401);
      expect((await request(anon()).get(`${BASE}/nodes/${node.nodeId}/log`).set(bearer(node.nodeToken))).status).toBe(401);
    });

    it('404s a machine the caller does not own, and says nothing about whose it is', async () => {
      const mine = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
      await shipLines(theirs.nodeToken, [{ seq: 0, text: 'secret\n' }]);

      const res = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${theirs.nodeId}/log`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'no such machine log' });

      const missing = await request(as('member', 'u-mia')).get(`${BASE}/nodes/node-nope/log`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: 'no such machine log' });

      expect((await request(as('member', 'u-mia')).get(`${BASE}/nodes/${mine.nodeId}/log`)).status).toBe(200);
    });

    it('returns the empty shape for a paired machine that has shipped nothing yet', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      const res = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${node.nodeId}/log`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        nodeId: node.nodeId, entries: [], lastSeq: -1, bytes: 0, updatedAt: null,
      });
    });

    it('honours ?since to return only lines after a poller cursor', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      await shipLines(node.nodeToken, [
        { seq: 0, text: 'a\n' }, { seq: 1, text: 'b\n' }, { seq: 2, text: 'c\n' },
      ]);
      const res = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${node.nodeId}/log`).query({ since: 1 });
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e: { seq: number }) => e.seq)).toEqual([2]);
      expect(res.body.lastSeq).toBe(2);
    });

    it('answers degraded: true, never a 500, when the owner lookup fails', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      // Pairing above ran with the mock provider (config.mock.aurora === true,
      // the default this whole file mocks it to). Flip it off here so
      // listNodesByOwner takes the real Aurora path — through the SAME
      // mocked exec() every other test in this file leaves unconfigured —
      // and restore it in `finally` so no later test in the file is affected.
      (config.mock as { aurora: boolean }).aurora = false;
      execMock.mockRejectedValueOnce(new Error('Data API unavailable'));
      try {
        const res = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${node.nodeId}/log`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          nodeId: node.nodeId, entries: [], lastSeq: -1, bytes: 0, updatedAt: null,
          degraded: true, error: 'Data API unavailable',
        });
      } finally {
        (config.mock as { aurora: boolean }).aurora = true;
      }
    });
  });

  describe('GET /nodes/:id/log/stream (tail — browser, owner-scoped)', () => {
    it('401s a cookie-less caller', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      expect((await request(anon()).get(`${BASE}/nodes/${node.nodeId}/log/stream`)).status).toBe(401);
    });

    it('404s a machine the caller does not own', async () => {
      const theirs = await pair({ sub: 'u-raj' }, { label: 'raj-mbp' });
      const res = await request(as('member', 'u-mia')).get(`${BASE}/nodes/${theirs.nodeId}/log/stream`);
      expect(res.status).toBe(404);
    });

    it('replays the backlog then pushes a live line over SSE', async () => {
      const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
      await shipLines(node.nodeToken, [{ seq: 0, text: 'backlog\n' }]);

      const streamPath = `${BASE}/nodes/${node.nodeId}/log/stream`;
      const app = as('member', 'u-mia');
      const streamed = readStream(app, (buf) => buf.includes('live'), { path: streamPath, timeoutMs: 5000 });

      await new Promise((r) => setTimeout(r, 100));
      await shipLines(node.nodeToken, [{ seq: 1, text: 'live\n' }]);

      const body = await streamed;
      expect(body).toContain('backlog');
      expect(body).toContain('live');
    });
  });
});

// R8 follow-up: a local run gets the org's skill library as project skills in its checkout.
// The worker says so on the claim (`projectSkills: true`), the brief then points at
// ./.claude/skills, and the library comes over the fenced work-loop door.
describe('skills for a local run (R8)', () => {
  it('a worker that installs project skills, on a job with a repo, gets a brief that says so', async () => {
    const node = await readyWorker();
    await queueLocal('with repo', { prompt: 'Fix it.', repo: 'https://github.com/x/y' });
    const res = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({ projectSkills: true });
    expect(res.status).toBe(200);
    expect(res.body.skillLibrary).toMatchObject({ dir: './.claude/skills' });
    expect(res.body.job.payload.prompt).toContain('installed in `./.claude/skills`');
  });

  it('an older worker, or a job with no repo, is told the skills are not on this machine', async () => {
    const node = await readyWorker();
    await queueLocal('old worker', { prompt: 'Fix it.', repo: 'https://github.com/x/y' });
    const old = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});
    expect(old.status).toBe(200);
    expect(old.body.skillLibrary?.dir ?? null).toBeNull();
    expect(old.body.job.payload.prompt).not.toContain('installed in `');

    await queueLocal('no repo', { prompt: 'What is 10+10?' });
    const bare = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({ projectSkills: true });
    expect(bare.status).toBe(200);
    expect(bare.body.skillLibrary?.dir ?? null).toBeNull();
  });

  it('serves the library to the claim holder only, and 304s the sha it already has', async () => {
    const node = await readyWorker();
    await queueLocal('skills', { prompt: 'Fix it.', repo: 'https://github.com/x/y' });
    const c = await request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({ projectSkills: true });
    const path = `${BASE}/jobs/${c.body.job.id}/skills`;

    const lib = await request(anon()).post(path).set(bearer(node.nodeToken)).send({ claimToken: c.body.claimToken });
    expect(lib.status).toBe(200);
    expect(lib.body.format).toBe('orgiq-skill-library/1');
    expect(lib.headers['x-skill-library-sha256']).toBe(lib.body.sha256);
    expect(Array.isArray(lib.body.files)).toBe(true);

    const same = await request(anon()).post(path).set(bearer(node.nodeToken)).send({ claimToken: c.body.claimToken, have: lib.body.sha256 });
    expect(same.status).toBe(304);

    expect((await request(anon()).post(path).set(bearer(node.nodeToken)).send({ claimToken: 'clm_deadbeef' })).status).toBe(409);
    expect((await request(anon()).post(path).set(bearer(node.nodeToken)).send({})).status).toBe(400);
    expect((await request(anon()).post(path).send({ claimToken: c.body.claimToken })).status).toBe(401);
    const other = await readyWorker({ sub: 'u-raj', label: 'raj-mbp' });
    expect((await request(anon()).post(path).set(bearer(other.nodeToken)).send({ claimToken: c.body.claimToken })).status).toBe(404);
  });
});
