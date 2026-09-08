// routes/local-compute.ts — all ten routes, and the thing that makes this
// router different from every other one: it is mounted UNGATED in index.ts.
//
// That is deliberate (`app.use('/api/local-compute', localComputeRouter)`,
// index.ts:337). Three of its routes are MACHINE callbacks — a developer's
// laptop POSTing presence with a node token and no cookie — so a blanket
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
import { exec } from '../../providers/aurora.js';
import { type Role, type Session } from '../../lib/session.js';

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
  resetRateLimits();
  clearAuthzCache();
  execMock.mockReset();
});

afterEach(() => {
  unfreezeClock();
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
      'acceptJobs', 'createdAt', 'id', 'label', 'lastSeenAt', 'localModels',
      'ownerId', 'platform', 'presence', 'revokedAt',
    ]);
    expect(row.ownerId).toBe('u-mia');
    expect(row.label).toBe('mia-mbp');
    expect(row.platform).toBe('darwin/arm64');
    expect(row.acceptJobs).toBe(false);
    expect(row.localModels).toEqual([]);
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
      'acceptJobs', 'createdAt', 'id', 'label', 'lastSeenAt', 'localModels',
      'ownerId', 'platform', 'presence', 'revokedAt',
    ]);
  });

  it('drops a revoked machine from the fleet listing', async () => {
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`);
    const res = await request(as('org-leader', 'u-ops')).get('/api/local-compute/nodes/all');
    expect(res.body.nodes.map((n: { id: string }) => n.id)).not.toContain(node.nodeId);
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
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const { port, headers: appHeaders } = attachToSharedServer(app);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/local-compute/stream', headers: { ...appHeaders, ...(opts.headers ?? {}) } },
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
      'acceptJobs', 'createdAt', 'id', 'label', 'lastSeenAt', 'localModels',
      'ownerId', 'platform', 'presence', 'revokedAt',
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

  it('a second revoke does not revive the row or the token', async () => {
    // ⚠️ The STATUS CODE of a repeat revoke diverges between the two provider
    // branches and is deliberately not asserted here — see the note in the
    // report accompanying this suite. Aurora's UPDATE carries
    // `AND revoked_at IS NULL` (providers/local-compute.ts:287) so the second
    // call matches no row and the route 404s; the MOCK branch
    // (providers/local-compute.ts:279-284) omits that predicate, returns true
    // again, and the route answers 200 while re-stamping revoked_at to a later
    // instant than the actual revocation. Pinning either code here would
    // freeze one of the two disagreeing answers as correct. What must hold in
    // both, and is asserted, is that a repeat revoke never brings the machine
    // or its credential back.
    const node = await pair({ sub: 'u-mia' }, { label: 'mia-mbp' });
    expect((await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`)).status).toBe(200);
    await request(as('member', 'u-mia')).delete(`/api/local-compute/nodes/${node.nodeId}`);

    const listed = await request(as('member', 'u-mia')).get('/api/local-compute/nodes');
    expect(listed.body.nodes.map((n: { id: string }) => n.id)).not.toContain(node.nodeId);
    const announce = await request(anon()).post('/api/local-compute/announce').set(bearer(node.nodeToken)).send({ sessions: [] });
    expect(announce.status).toBe(401);
  });
});
