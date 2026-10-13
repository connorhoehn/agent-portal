// lib/access-expiry.ts: the sweeper revokes an elevation past its expiresAt
// through lib/access-provision.ts, sends the 24-hour warning once, and is
// single-flight across replicas (lib/replica-fleet.ts — the dispatcher's boot
// recovery pattern: no peers → sweep; peers → only under the fleet lock).
//
// Two replicas are simulated as two ReplicaFleet handles sharing one lock
// table (what Redis is to the real fleet), each seeing the other as a peer.
// The directory and the store are the real memory providers (MOCK_AURORA).

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import { dueRows, sweepAccessExpiry } from '../access-expiry.js';
import { provisionAccess } from '../access-provision.js';
import type { ReplicaFleet } from '../replica-fleet.js';
import { getUser } from '../../providers/identity.js';
import { setNotificationSink, type NotificationInputLike } from '../social-notify.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture, type AccessRequestRow } from '../../mock/access-requests.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';

const PROVISIONED = '2026-10-13T12:00:00.000Z';
const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.parse(PROVISIONED) + ms).toISOString();
let bell: Array<{ userId: string; item: NotificationInputLike }>;
let restoreClock: () => void;

const row = (id: string): AccessRequestRow => accessRequestsFixture.rows().find((r) => r.id === id)!;
const kinds = (id: string) => accessEventsFixture.rows().filter((e) => e.requestId === id).map((e) => e.kind);
const setClock = (iso: string) => { restoreClock(); restoreClock = freezeClock(iso); };

/** Two replicas over one lock table; `slow` holds the lock open until released. */
function fleetPair(): { a: ReplicaFleet; b: ReplicaFleet; locks: Map<string, string> } {
  const locks = new Map<string, string>();
  const make = (id: string, peer: string): ReplicaFleet => ({
    id,
    async heartbeat() {},
    async members() { return [id, peer]; },
    async peers() { return [peer]; },
    async withLock<T>(name: string, _ttl: number, fn: () => Promise<T>) {
      if (locks.has(name)) return null;
      locks.set(name, id);
      try { return await fn(); } finally { if (locks.get(name) === id) locks.delete(name); }
    },
    async leave() {},
    stop() {},
  });
  return { a: make('replica-a', 'replica-b'), b: make('replica-b', 'replica-a'), locks };
}
const solo: ReplicaFleet = {
  id: 'solo', async heartbeat() {}, async members() { return ['solo']; }, async peers() { return []; },
  async withLock<T>(_n: string, _t: number, fn: () => Promise<T>) { return fn(); }, async leave() {}, stop() {},
};

beforeEach(async () => {
  restoreClock = freezeClock(PROVISIONED);
  for (const f of [accessCatalogFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture, initiatives]) f.reset();
  bell = [];
  setNotificationSink({ notifyUser: async (userId, item) => { bell.push({ userId, item }); } });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Rhea's 30-day SME elevation, provisioned now.
  row('req-0001').status = 'approved';
  await provisionAccess({ id: 'req-0001' });
  bell = [];
});
afterEach(() => { setNotificationSink(null); restoreClock(); unfreezeClock(); jest.restoreAllMocks(); });

it('dueRows picks what has expired and what enters its last day unwarned', () => {
  const r = row('req-0001');
  expect(dueRows([r], at(29 * 24 * HOUR - 1))).toEqual({ expire: [], warn: [] });
  expect(dueRows([r], at(29 * 24 * HOUR + 1)).warn.map((x) => x.id)).toEqual(['req-0001']);
  expect(dueRows([{ ...r, expiryWarnedAt: PROVISIONED }], at(29 * 24 * HOUR + 1)).warn).toEqual([]);
  expect(dueRows([r], at(30 * 24 * HOUR)).expire.map((x) => x.id)).toEqual(['req-0001']);
  // A standing grant (no expiresAt) and a request that is not live are never due.
  expect(dueRows([{ ...r, expiresAt: null }, { ...r, status: 'revoked' }], at(400 * 24 * HOUR))).toEqual({ expire: [], warn: [] });
});

it('nothing is due before the window', async () => {
  setClock(at(HOUR));
  expect(await sweepAccessExpiry(solo)).toEqual({ ran: 'swept', expired: [], warned: [], failed: [] });
  expect(row('req-0001').status).toBe('active');
});

describe('the 24-hour warning', () => {
  it('goes to the requester and beneficiary once, however many sweeps and replicas', async () => {
    setClock(at(30 * 24 * HOUR - 12 * HOUR));
    const { a, b } = fleetPair();
    const [ra, rb] = await Promise.all([sweepAccessExpiry(a), sweepAccessExpiry(b)]);
    expect([ra.ran, rb.ran].sort()).toEqual(['locked-elsewhere', 'swept']);
    expect([...ra.warned, ...rb.warned]).toEqual(['req-0001']);
    expect((await sweepAccessExpiry(a)).warned).toEqual([]);
    expect((await sweepAccessExpiry(solo)).warned).toEqual([]);
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ userId: 'u-rhea', item: { id: 'access:expiring:req-0001', title: 'SME in Work expires within a day',
      payload: { tenant: 'access', kind: 'access-expiring', requestId: 'req-0001' }, action: { href: '/access/requests/req-0001' } } });
    expect(row('req-0001')).toMatchObject({ status: 'active', expiryWarnedAt: at(30 * 24 * HOUR - 12 * HOUR) });
    // A warning is not a transition: the audit trail is unchanged.
    expect(kinds('req-0001')).toEqual(['submitted', 'provisioned']);
  });
});

describe('expiry', () => {
  it('two replicas sweeping together revoke once, through the provisioning path', async () => {
    const epoch = (await getUser('u-rhea'))!.epoch;
    setClock(at(30 * 24 * HOUR + 1));
    const { a, b, locks } = fleetPair();
    const [ra, rb] = await Promise.all([sweepAccessExpiry(a), sweepAccessExpiry(b)]);
    expect([ra.ran, rb.ran].sort()).toEqual(['locked-elsewhere', 'swept']);
    expect([...ra.expired, ...rb.expired]).toEqual(['req-0001']);
    expect(locks.size).toBe(0);
    expect(row('req-0001')).toMatchObject({ status: 'expired', revokedAt: at(30 * 24 * HOUR + 1) });
    expect(kinds('req-0001')).toEqual(['submitted', 'provisioned', 'expired']);
    expect(accessEventsFixture.rows().find((e) => e.requestId === 'req-0001' && e.kind === 'expired')).toMatchObject({ actorId: null, beforeStatus: 'active' });
    // The grant is gone and her sessions retire (one bump for one revoke).
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'] });
    expect((await getUser('u-rhea'))!.epoch).toBe(epoch + 1);
    expect(bell.map((x) => [x.userId, x.item.payload?.['kind']])).toEqual([['u-rhea', 'access-expired']]);

    // The replica that lost the lock sweeps next tick and finds nothing.
    const later = await sweepAccessExpiry(b);
    expect(later).toMatchObject({ ran: 'swept', expired: [] });
    expect(kinds('req-0001').filter((k) => k === 'expired')).toHaveLength(1);
  });

  it('even without the lock (two solo sweeps racing in one process), the row claim revokes once', async () => {
    setClock(at(31 * 24 * HOUR));
    const [x, y] = await Promise.all([sweepAccessExpiry(solo), sweepAccessExpiry(solo)]);
    expect([...x.expired, ...y.expired]).toEqual(['req-0001']);
    expect(kinds('req-0001').filter((k) => k === 'expired')).toHaveLength(1);
  });

  it('an unreachable fleet lock skips the sweep rather than sweeping unlocked', async () => {
    setClock(at(31 * 24 * HOUR));
    const broken: ReplicaFleet = { ...fleetPair().a, async withLock() { throw new Error('ECONNREFUSED'); } };
    expect(await sweepAccessExpiry(broken)).toEqual({ ran: 'lock-unavailable', expired: [], warned: [], failed: [] });
    expect(row('req-0001').status).toBe('active');
  });
});
