// Local compute, offline — the properties the missing fixtures cost.
//
// Before mock/local-compute.ts, three module-level `Map`s in
// providers/local-compute.ts and one more in lib/local-compute-fleet.ts held
// this whole feature's mock state, none of them registered. So
// `POST /api/__mock/reset` could not undo a claim, a rename, a revoke, an
// announce or a heartbeat, and mock/core/wire/write-policy.ts refused six
// routes as `unresettable` — their response shapes are still unpinned today.
//
// These tests are therefore not "does a row appear". Each asserts one property
// the fixture is there to provide:
//
//   1. THE WRITE LANDS, through the provider's own public API — not an
//      echo-back, and not a peek at the fixture.
//   2. `reset()` PUTS THE SEED BACK, field for field, so a write that leaked
//      something the reset does not restore fails here.
//   3. STAMPS COME FROM THE CLOCK — frozen, so every assertion is an exact
//      string rather than a range.
//   4. THE DERIVED STATUS IS DERIVED — connected/stale/offline are read off a
//      frozen instant, never claimed by a row.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { freezeClock, fixtureRegistry } from '../core/index.js';
import {
  DEMO_NODE_ID,
  MOCK_NODE_TOKEN,
  MOCK_NODE_TOKENS,
  computeNodes,
  localPresence,
  pairingCodes,
} from '../local-compute.js';
import {
  claimPairingCode,
  createPairingCode,
  getNode,
  getNodeByToken,
  listAllNodes,
  listNodesByOwner,
  renameNode,
  revokeNode,
  setAcceptJobs,
  touchNode,
} from '../../providers/local-compute.js';
import {
  endSession,
  presenceOf,
  recordAnnounce,
  recordHeartbeat,
  statusOfNode,
  type LocalSession,
} from '../../lib/local-compute-fleet.js';

// `config.mock.aurora` is mocked above, but the presence seed reads
// MOCK_AURORA from the environment (mock/local-compute.ts says why: config.ts
// uses import.meta.url and will not import under the CJS jest config). Set it
// for this file only.
const priorMockAurora = process.env['MOCK_AURORA'];
beforeAll(() => { process.env['MOCK_AURORA'] = 'true'; });
afterAll(() => {
  if (priorMockAurora === undefined) delete process.env['MOCK_AURORA'];
  else process.env['MOCK_AURORA'] = priorMockAurora;
});

let restore = () => {};
function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
}

beforeEach(() => {
  fixtureRegistry.resetAll('default');
});

afterEach(() => {
  restore();
  restore = () => {};
  fixtureRegistry.resetAll('default');
});

const session = (id: string, extra: Partial<LocalSession> = {}): LocalSession => ({
  sessionId: id,
  harness: 'claude-code',
  lastSeenAt: '',
  ...extra,
});

// ─── The seeded cast ─────────────────────────────────────────────────────────

describe('the seeded fleet', () => {
  it('renders three machines, one per arm of the status ladder', async () => {
    freeze('2026-09-07T12:00:00.000Z');
    const all = await listAllNodes();
    expect(all.map((n) => n.id)).toEqual([
      'node-operator-mini',      // paired 96 days ago
      DEMO_NODE_ID,              // 41 days
      'node-operator-thinkpad',  // earlier today
    ]);
    expect(all.map((n) => presenceOf(n.id).status)).toEqual(['offline', 'connected', 'stale']);
  });

  it('an offline machine reports no sessions even though its row holds one', () => {
    freeze('2026-09-07T12:00:00.000Z');
    const seeded = localPresence.rows().find((r) => r.nodeId === 'node-operator-mini');
    expect(seeded!.sessions).toHaveLength(1);
    expect(presenceOf('node-operator-mini').sessions).toEqual([]);
  });

  it('ages are ages, not day buckets — a 20-minute-old heartbeat just after UTC midnight is still offline', () => {
    // The bug this pins: `keepWithinToday` would clamp the offset to the part
    // of the day elapsed, turning a 20-minute-old heartbeat at 00:05 into a
    // five-minute-old one and reviving a dead machine as `stale`.
    freeze('2026-09-07T00:05:00.000Z');
    expect(presenceOf('node-operator-mini').status).toBe('offline');
    expect(presenceOf('node-operator-thinkpad').status).toBe('stale');
    expect(presenceOf(DEMO_NODE_ID).status).toBe('connected');
  });

  it('the machine paired "earlier today" stays inside today at 00:05 UTC', async () => {
    freeze('2026-09-07T00:05:00.000Z');
    const node = await getNode('node-operator-thinkpad');
    // Five hours before 00:05 is yesterday; the clamp holds it at UTC midnight.
    expect(node!.createdAt).toBe('2026-09-07T00:00:00.000Z');
  });

  it('every ownership split is real — the sweep persona and the cookie-less demo identity each own machines', async () => {
    expect((await listNodesByOwner('demo-user')).map((n) => n.id)).toEqual([DEMO_NODE_ID]);
    expect((await listNodesByOwner('u-operator')).map((n) => n.id)).toEqual([
      'node-operator-mini',
      'node-operator-thinkpad',
    ]);
  });

  it('never projects the token hash onto the wire', async () => {
    const node = await getNode(DEMO_NODE_ID);
    expect(Object.keys(node!).sort()).toEqual([
      'acceptJobs', 'createdAt', 'id', 'jobKinds', 'label', 'lastClaimAt', 'lastSeenAt',
      'localModels', 'maxConcurrency', 'ownerId', 'platform', 'revokedAt',
    ]);
    expect(JSON.stringify(node)).not.toContain('tokenHash');
  });

  it('resolves MOCK_NODE_TOKEN through the provider — which is what proves the two sha256 copies agree', async () => {
    const node = await getNodeByToken(MOCK_NODE_TOKEN);
    expect(node?.id).toBe(DEMO_NODE_ID);
    // The prefix guard runs before the hash, so a token without it is rejected
    // without a lookup at all.
    expect(await getNodeByToken('mock-local-node-token')).toBeNull();

    // Every seeded machine's token resolves to exactly its own node — the
    // property that lets an audit announce as a seeded machine rather than
    // having to pair one first.
    for (const [nodeId, token] of Object.entries(MOCK_NODE_TOKENS)) {
      expect((await getNodeByToken(token))?.id).toBe(nodeId);
    }
  });
});

// ─── Pairing ─────────────────────────────────────────────────────────────────

describe('pairing', () => {
  it('claims the seeded code once, mints a node, and refuses the second claim', async () => {
    freeze('2026-09-07T12:00:00.000Z');
    const claimed = await claimPairingCode('MKPAD234', { label: 'new-laptop', nodeId: 'node-new' });
    expect(claimed).toEqual({ nodeId: 'node-new', nodeToken: expect.stringMatching(/^lcn_[0-9a-f]{48}$/) });

    const created = await getNode('node-new');
    expect(created).toEqual({
      id: 'node-new', ownerId: 'u-operator', label: 'new-laptop', platform: null,
      acceptJobs: false, localModels: [], jobKinds: [], maxConcurrency: 1,
      createdAt: '2026-09-07T12:00:00.000Z', lastSeenAt: null, lastClaimAt: null, revokedAt: null,
    });
    // The token it handed back authenticates, and only that one.
    expect((await getNodeByToken(claimed!.nodeToken))?.id).toBe('node-new');

    expect(await claimPairingCode('MKPAD234', { label: 'second-laptop' })).toBeNull();
  });

  it('refuses an expired code — the seeded one lives exactly ten minutes', async () => {
    freeze('2026-09-07T12:00:00.000Z');
    expect(pairingCodes.rows()[0]!.expiresAt).toBe('2026-09-07T12:10:00.000Z');
    freeze('2026-09-07T12:10:00.001Z');
    expect(await claimPairingCode('MKPAD234', { label: 'too-late' })).toBeNull();
  });

  it('a minted code is claimable, and reset drops it', async () => {
    freeze('2026-09-07T12:00:00.000Z');
    const pairing = await createPairingCode('u-operator');
    expect(pairing.expiresAt).toBe('2026-09-07T12:10:00.000Z');
    expect(pairing.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

    fixtureRegistry.resetAll('default');
    expect(pairingCodes.rows().map((c) => c.code)).toEqual(['MKPAD234']);
    expect(await claimPairingCode(pairing.code, { label: 'orphan' })).toBeNull();
  });

  it('re-pairing a machine keeps its id, its created_at and its OWNER, and clears the revoke', async () => {
    // The Map this replaced overwrote the whole row, so a re-pair moved a
    // machine to whoever held the newest code. Aurora's ON CONFLICT (id) DO
    // UPDATE touches label, platform, token_hash and revoked_at — nothing else.
    freeze('2026-09-07T12:00:00.000Z');
    expect(await revokeNode(DEMO_NODE_ID, 'demo-user')).toBe(true);

    freeze('2026-09-07T13:00:00.000Z');
    const claimed = await claimPairingCode('MKPAD234', {
      nodeId: DEMO_NODE_ID, label: 'demo-macbook-reimaged', platform: 'darwin/arm64',
    });
    const node = await getNode(DEMO_NODE_ID);
    expect(node!.ownerId).toBe('demo-user');            // NOT u-operator, who held the code
    expect(node!.createdAt).toBe(computeNodes.rows(/* live */).find((n) => n.id === DEMO_NODE_ID)!.createdAt);
    expect(node!.label).toBe('demo-macbook-reimaged');
    expect(node!.revokedAt).toBeNull();
    // The old token is dead; the new one works.
    expect(await getNodeByToken(MOCK_NODE_TOKEN)).toBeNull();
    expect((await getNodeByToken(claimed!.nodeToken))?.id).toBe(DEMO_NODE_ID);
  });
});

// ─── Node management ─────────────────────────────────────────────────────────

describe('node management', () => {
  it('renames only for the owner, and reset restores the seeded label', async () => {
    expect(await renameNode(DEMO_NODE_ID, 'u-operator', 'not-yours')).toBeNull();
    const renamed = await renameNode(DEMO_NODE_ID, 'demo-user', 'connor-macbook');
    expect(renamed!.label).toBe('connor-macbook');
    expect((await getNode(DEMO_NODE_ID))!.label).toBe('connor-macbook');

    fixtureRegistry.resetAll('default');
    expect((await getNode(DEMO_NODE_ID))!.label).toBe('demo-macbook');
  });

  it('toggles accept-jobs, and reset restores the seeded value', async () => {
    expect((await setAcceptJobs(DEMO_NODE_ID, 'demo-user', true))!.acceptJobs).toBe(true);
    fixtureRegistry.resetAll('default');
    expect((await getNode(DEMO_NODE_ID))!.acceptJobs).toBe(false);
    // The thinkpad is seeded opted-in, so the control has both states on screen.
    expect((await getNode('node-operator-thinkpad'))!.acceptJobs).toBe(true);
  });

  it('a second revoke matches no row and never re-stamps the audit instant', async () => {
    // Aurora carries `AND revoked_at IS NULL`; the Map branch did not, so a
    // repeated DELETE answered 200 and moved `revoked_at` forward every time.
    freeze('2026-09-07T12:00:00.000Z');
    expect(await revokeNode(DEMO_NODE_ID, 'demo-user')).toBe(true);
    expect((await getNode(DEMO_NODE_ID))!.revokedAt).toBe('2026-09-07T12:00:00.000Z');

    freeze('2026-09-07T18:00:00.000Z');
    expect(await revokeNode(DEMO_NODE_ID, 'demo-user')).toBe(false);
    expect((await getNode(DEMO_NODE_ID))!.revokedAt).toBe('2026-09-07T12:00:00.000Z');
  });

  it('a revoked machine leaves the listings but keeps its row, and its token stops working', async () => {
    expect(await revokeNode(DEMO_NODE_ID, 'demo-user')).toBe(true);
    expect((await listAllNodes()).map((n) => n.id)).not.toContain(DEMO_NODE_ID);
    expect(await listNodesByOwner('demo-user')).toEqual([]);
    expect(await getNode(DEMO_NODE_ID)).not.toBeNull();   // the audit row survives
    expect(await getNodeByToken(MOCK_NODE_TOKEN)).toBeNull();

    fixtureRegistry.resetAll('default');
    expect((await getNode(DEMO_NODE_ID))!.revokedAt).toBeNull();
    expect((await getNodeByToken(MOCK_NODE_TOKEN))?.id).toBe(DEMO_NODE_ID);
  });

  it('touch stamps last_seen_at from the clock, and reset puts the seeded age back', async () => {
    freeze('2026-09-07T12:00:00.000Z');
    const seeded = (await getNode(DEMO_NODE_ID))!.lastSeenAt;
    expect(seeded).toBe('2026-09-07T11:59:30.000Z');   // 30 seconds — connected

    freeze('2026-09-07T12:34:56.000Z');
    await touchNode(DEMO_NODE_ID);
    expect((await getNode(DEMO_NODE_ID))!.lastSeenAt).toBe('2026-09-07T12:34:56.000Z');

    // Reset restores the seeded AGE, not the instant the fixture last
    // materialized at — the whole point of building rows from the clock at
    // read time. Thirty seconds before the now that is live when reset runs.
    fixtureRegistry.resetAll('default');
    expect((await getNode(DEMO_NODE_ID))!.lastSeenAt).toBe('2026-09-07T12:34:26.000Z');
  });
});

// ─── Presence ────────────────────────────────────────────────────────────────

describe('presence', () => {
  it('an announce, an end and a heartbeat all survive until reset undoes every one', () => {
    freeze('2026-09-07T12:00:00.000Z');

    // 1. Announce two sessions onto a machine that had one.
    const announced = recordAnnounce(DEMO_NODE_ID, [session('a'), session('b')]);
    expect(announced.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(announced.lastSeenAt).toBe('2026-09-07T12:00:00.000Z');
    expect(announced.status).toBe('connected');

    // 2. End one of them.
    expect(endSession(DEMO_NODE_ID, 'a')).toBe(true);
    expect(presenceOf(DEMO_NODE_ID).sessions.map((s) => s.sessionId)).toEqual(['b']);

    // 3. Heartbeat the stale machine back to connected — the transition the
    //    write policy calls out as having "no way back".
    expect(presenceOf('node-operator-thinkpad').status).toBe('stale');
    recordHeartbeat('node-operator-thinkpad');
    expect(presenceOf('node-operator-thinkpad')).toMatchObject({
      status: 'connected',
      lastSeenAt: '2026-09-07T12:00:00.000Z',
    });

    // 4. One reset, and all three are undone.
    fixtureRegistry.resetAll('default');
    expect(presenceOf(DEMO_NODE_ID).sessions.map((s) => s.sessionId))
      .toEqual(['demo-local-session-0000000000000000000']);
    expect(presenceOf(DEMO_NODE_ID).lastSeenAt).toBe('2026-09-07T11:59:30.000Z');
    expect(presenceOf('node-operator-thinkpad').status).toBe('stale');
  });

  it('announcing onto an unknown node adds a row, and reset removes it entirely', () => {
    freeze('2026-09-07T12:00:00.000Z');
    recordAnnounce('node-nobody-knows', [session('x')]);
    expect(presenceOf('node-nobody-knows').status).toBe('connected');

    fixtureRegistry.resetAll('default');
    expect(presenceOf('node-nobody-knows')).toEqual({
      nodeId: 'node-nobody-knows', status: 'offline', lastSeenAt: null, sessions: [],
    });
  });

  it('reads are copies — a caller cannot edit presence by reference', () => {
    freeze('2026-09-07T12:00:00.000Z');
    recordAnnounce(DEMO_NODE_ID, [session('a', { touching: ['src/one.ts'] })]);
    const first = presenceOf(DEMO_NODE_ID);
    first.sessions[0]!.intent = 'tampered';
    first.sessions[0]!.touching!.push('src/two.ts');
    expect(presenceOf(DEMO_NODE_ID).sessions[0]!.intent).toBeUndefined();
    expect(presenceOf(DEMO_NODE_ID).sessions[0]!.touching).toEqual(['src/one.ts']);
  });

  it('derives the horizons off the clock the fixture writes with', () => {
    freeze('2026-09-07T12:00:00.000Z');
    expect(statusOfNode('2026-09-07T11:58:30.000Z')).toBe('connected');  // exactly 90s
    expect(statusOfNode('2026-09-07T11:58:29.000Z')).toBe('stale');      // 91s
    expect(statusOfNode('2026-09-07T11:55:00.000Z')).toBe('stale');      // exactly 5min
    expect(statusOfNode('2026-09-07T11:54:59.000Z')).toBe('offline');    // 5min + 1s
    expect(statusOfNode(null)).toBe('offline');
  });
});

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe('scenarios', () => {
  afterEach(() => fixtureRegistry.resetAll('default'));

  it('empty is empty — the state the "pair your first machine" copy is for', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listAllNodes()).toEqual([]);
    expect(pairingCodes.rows()).toEqual([]);
    expect(localPresence.rows()).toEqual([]);
  });

  it('fresh is machines that have never announced — every badge offline, last_seen_at NULL', async () => {
    fixtureRegistry.resetAll('fresh');
    const all = await listAllNodes();
    expect(all).toHaveLength(3);
    expect(all.every((n) => n.lastSeenAt === null)).toBe(true);
    expect(all.map((n) => presenceOf(n.id).status)).toEqual(['offline', 'offline', 'offline']);
  });

  it('large is a density fleet with the ladder spread across it', async () => {
    fixtureRegistry.resetAll('large');
    const all = await listAllNodes();
    expect(all).toHaveLength(24);
    const statuses = new Set(all.map((n) => presenceOf(n.id).status));
    expect([...statuses].sort()).toEqual(['connected', 'offline', 'stale']);
  });

  it('is registered, so the control plane can reach all three fixtures by key', () => {
    for (const key of ['compute-nodes', 'compute-pairing-codes', 'local-presence']) {
      expect(fixtureRegistry.get(key)?.key).toBe(key);
    }
  });
});
