// lib/access-provision.ts against the REAL memory identity provider (the
// MOCK_AURORA seed mirror in providers/identity.ts, writes landing in the
// registered `identity.grant-writes` fixture) and the registered initiatives
// fixture — no identity mock, so a grant written here is the grant every
// other route reads.
//
//   * a tenant-role request writes the ONE role into the beneficiary's grants
//     through grantRole (their other grants untouched), does NOT bump their
//     epoch (A3: the grant reaches open cookies at the grants refresh; live
//     readers still hear onDirectoryChange), records
//     `provisioned`, and lands `active` with expiresAt from its duration;
//   * an initiative membership inserts the contribution through the writer;
//   * re-provisioning changes nothing (no second bump, event or bell item);
//   * revoke is the inverse AND bumps the epoch; a second revoke changes nothing;
//   * a request that is not approved, or cannot be written, is refused before
//     anything is claimed;
//   * reset undoes every write.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import { provisionAccess, revokeAccess, expiresAtFor } from '../access-provision.js';
import { getUser, onDirectoryChange, setGrants } from '../../providers/identity.js';
import { listInitiativeMemberships } from '../../providers/projects.js';
import { setNotificationSink, type NotificationInputLike } from '../social-notify.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../mock/access-requests.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { findInitiative, initiatives } from '../../mock/initiatives.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';
import type { AccessRequestRow } from '../../mock/access-requests.js';

const NOW = '2026-10-13T12:00:00.000Z';
let bell: Array<{ userId: string; item: NotificationInputLike }>;
let changed: string[];
let stopListening: () => void;

const row = (id: string): AccessRequestRow => accessRequestsFixture.rows().find((r) => r.id === id)!;
const approve = (id: string) => { row(id).status = 'approved'; };
const eventsOf = (id: string) => accessEventsFixture.rows().filter((e) => e.requestId === id);

beforeEach(() => {
  freezeClock(NOW);
  for (const f of [accessCatalogFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture, initiatives]) f.reset();
  bell = [];
  setNotificationSink({ notifyUser: async (userId, item) => { bell.push({ userId, item }); } });
  changed = [];
  stopListening = onDirectoryChange((id) => changed.push(id));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { stopListening(); setNotificationSink(null); unfreezeClock(); jest.restoreAllMocks(); });

describe('provisionAccess: a tenant role', () => {
  it('writes the role through grantRole without bumping the epoch, records provisioned, lands active', async () => {
    const before = structuredClone((await getUser('u-rhea'))!);
    expect(before.grants).toEqual({ access: ['requester'] });
    approve('req-0001');
    const out = await provisionAccess({ id: 'req-0001' });

    expect(out.changed).toBe(true);
    expect(out.request).toMatchObject({ status: 'active', provisionedAt: NOW, expiresAt: expiresAtFor('30d', NOW) });
    expect(out.request.expiresAt).toBe('2026-11-12T12:00:00.000Z');
    const after = (await getUser('u-rhea', { authoritative: true }))!;
    // Merged, not replaced: the access grant she holds stays.
    expect(after.grants).toEqual({ access: ['requester'], orgiq: ['sme'] });
    // The one store: the write is a grant row on the identity directory.
    expect(identityGrantWritesFixture.rows()).toEqual([{ userId: 'u-rhea', grants: { access: ['requester'], orgiq: ['sme'] } }]);
    // A3: no epoch bump on a grant (her open cookie stays valid); live readers heard the grant write.
    expect(after.epoch).toBe(before.epoch);
    expect(changed).toEqual(['u-rhea']);
    expect(eventsOf('req-0001').map((e) => [e.kind, e.actorId, e.beforeStatus, e.afterStatus])).toEqual([
      ['submitted', 'u-rhea', 'draft', 'submitted'],
      ['provisioned', null, 'approved', 'active'],
    ]);
    // The bell: one item to Rhea (requester and beneficiary are one person), inside /access.
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ userId: 'u-rhea', item: { title: 'SME in Work is active for Rhea Castellanos',
      payload: { tenant: 'access', category: 'Access', kind: 'access-provisioned', requestId: 'req-0001' },
      action: { href: '/access/requests/req-0001' } } });
  });

  it('is idempotent: a second provision writes, records and rings nothing', async () => {
    approve('req-0001');
    await provisionAccess({ id: 'req-0001' });
    const epoch = (await getUser('u-rhea'))!.epoch;
    const events = eventsOf('req-0001').length;
    const again = await provisionAccess({ id: 'req-0001' });
    expect(again.changed).toBe(false);
    expect(again.request.status).toBe('active');
    expect((await getUser('u-rhea'))!.epoch).toBe(epoch);
    expect(eventsOf('req-0001')).toHaveLength(events);
    expect(bell).toHaveLength(1);
  });

  it('two concurrent provisions of one request write once', async () => {
    approve('req-0001');
    const epoch = (await getUser('u-rhea'))!.epoch;
    const [a, b] = await Promise.all([provisionAccess({ id: 'req-0001' }), provisionAccess({ id: 'req-0001' })]);
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
    expect((await getUser('u-rhea'))!.epoch).toBe(epoch);
    expect(identityGrantWritesFixture.rows()).toHaveLength(1);
    expect(eventsOf('req-0001').filter((e) => e.kind === 'provisioned')).toHaveLength(1);
  });

  it('a standing grant has no expiry', async () => {
    approve('req-0001');
    row('req-0001').duration = 'standing';
    expect((await provisionAccess({ id: 'req-0001' })).request.expiresAt).toBeNull();
  });

  it('refuses a request that is not approved, and touches nothing', async () => {
    await expect(provisionAccess({ id: 'req-0001' })).rejects.toMatchObject({ status: 409 });
    await expect(provisionAccess({ id: 'req-0005' })).rejects.toMatchObject({ status: 409 });
    await expect(provisionAccess({ id: 'req-9999' })).rejects.toMatchObject({ status: 404 });
    expect(identityGrantWritesFixture.rows()).toEqual([]);
    expect(row('req-0001').status).toBe('submitted');
  });

  it('reset undoes the write: the seed grants come back', async () => {
    approve('req-0001');
    await provisionAccess({ id: 'req-0001' });
    identityGrantWritesFixture.reset();
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'] });
  });
});

describe('provisionAccess: an initiative membership', () => {
  it('inserts the contribution through the writer; the membership rule reads it', async () => {
    expect(findInitiative('p-auth-migration')!.smes).not.toContain('p-rhea');
    approve('req-0002');
    const out = await provisionAccess({ id: 'req-0002' });
    expect(out.request.status).toBe('active');
    expect(findInitiative('p-auth-migration')!.smes).toContain('p-rhea');
    expect((await listInitiativeMemberships('p-rhea')).map((m) => [m.id, m.membership])).toEqual([['p-auth-migration', 'contributor']]);
    // Her grants are untouched: a membership is not a role.
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'] });
    initiatives.reset();
    expect(findInitiative('p-auth-migration')!.smes).not.toContain('p-rhea');
  });

  it('a beneficiary with no linked person is refused before the row is claimed', async () => {
    accessRequestsFixture.rows().push({ ...row('req-0002'), id: 'req-0100', requesterId: 'u-dara', beneficiaryId: 'u-dara', status: 'approved' });
    await expect(provisionAccess({ id: 'req-0100' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no linked person/) });
    expect(row('req-0100')).toMatchObject({ status: 'approved', provisionedAt: null, expiresAt: null });
  });
});

describe('revokeAccess: the inverse', () => {
  it('removes the role, bumps the epoch, records revoked by the actor, stamps revokedAt; once', async () => {
    approve('req-0001');
    await provisionAccess({ id: 'req-0001' });
    const epoch = (await getUser('u-rhea'))!.epoch;
    bell = [];
    const out = await revokeAccess({ id: 'req-0001' }, 'No longer on the SSO cutover.', 'u-priya');
    expect(out.changed).toBe(true);
    expect(out.request).toMatchObject({ status: 'revoked', revokedAt: NOW });
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'] });
    expect((await getUser('u-rhea'))!.epoch).toBe(epoch + 1);
    expect(eventsOf('req-0001').at(-1)).toMatchObject({ kind: 'revoked', actorId: 'u-priya', beforeStatus: 'active', afterStatus: 'revoked', reason: 'No longer on the SSO cutover.' });
    expect(bell.map((b) => [b.userId, b.item.payload?.['kind']])).toEqual([['u-rhea', 'access-revoked']]);

    const again = await revokeAccess({ id: 'req-0001' }, 'again', 'u-priya');
    expect(again.changed).toBe(false);
    expect((await getUser('u-rhea'))!.epoch).toBe(epoch + 1);
    expect(eventsOf('req-0001').filter((e) => e.kind === 'revoked')).toHaveLength(1);
  });

  it('with no actor it is an expiry; a membership is detached', async () => {
    approve('req-0002');
    await provisionAccess({ id: 'req-0002' });
    const out = await revokeAccess({ id: 'req-0002' }, 'Reached its 30d end', null);
    expect(out.request.status).toBe('expired');
    expect(eventsOf('req-0002').at(-1)).toMatchObject({ kind: 'expired', actorId: null });
    expect(findInitiative('p-auth-migration')!.smes).not.toContain('p-rhea');
  });

  it('a request that never became active changes nothing', async () => {
    const out = await revokeAccess({ id: 'req-0001' }, null, 'u-priya');
    expect(out).toMatchObject({ changed: false, request: { status: 'submitted' } });
  });
});

describe('the provisioned audit reason reads as a date', () => {
  it('formats an ISO expiry as a calendar date in UTC', async () => {
    const { expiryLabel } = await import('../access-provision.js');
    expect(expiryLabel('2026-11-12T19:58:07.706Z')).toBe('Nov 12, 2026');
    expect(expiryLabel('not-a-date')).toBe('not-a-date');
  });
});

describe('concurrent writers to one person\'s grants (lane A finding, 2026-10-14)', () => {
  // The mock half of the race the native PostgreSQL contract runs on the
  // cluster statements (lib/access/__tests__/access-postgres.test.ts): every
  // writer changes only its own (tenant, role) row, with no per-beneficiary
  // lock, so none of them loses another's write; epochs move as A3 says.
  const second = (id: string, itemId: string) =>
    accessRequestsFixture.rows().push({ ...structuredClone(row('req-0001')), id, itemId, duration: '30d' });

  it('grant + grant: two requests for one beneficiary provisioned at once keep both roles, no bump', async () => {
    approve('req-0001');
    second('req-0099', 'capability:orgiq:budgets-read');
    const epoch = (await getUser('u-rhea'))!.epoch;
    const [a, b] = await Promise.all([provisionAccess({ id: 'req-0001' }), provisionAccess({ id: 'req-0099' })]);
    expect([a.changed, b.changed]).toEqual([true, true]);
    const after = (await getUser('u-rhea', { authoritative: true }))!;
    expect(after.grants).toEqual({ access: ['requester'], orgiq: ['sme', 'budgets-reader'] });
    expect(after.epoch).toBe(epoch);
  });

  it('grant + revoke: a provisioning racing a revocation keeps the new role, removes the old, bumps once', async () => {
    approve('req-0001');
    await provisionAccess({ id: 'req-0001' });
    second('req-0099', 'capability:orgiq:budgets-read');
    row('req-0099').status = 'approved';
    const epoch = (await getUser('u-rhea'))!.epoch;
    const [granted, revoked] = await Promise.all([
      provisionAccess({ id: 'req-0099' }),
      revokeAccess({ id: 'req-0001' }, 'Moved teams', 'u-priya'),
    ]);
    expect([granted.request.status, revoked.request.status]).toEqual(['active', 'revoked']);
    const after = (await getUser('u-rhea', { authoritative: true }))!;
    expect(after.grants).toEqual({ access: ['requester'], orgiq: ['budgets-reader'] });
    expect(after.epoch).toBe(epoch + 1);
  });

  it('admin edit + provisioning: a save from the matrix loaded before the grant keeps the grant', async () => {
    approve('req-0001');
    // The admin opens Rhea's record (before the grant), then the last approval provisions SME…
    const loaded = structuredClone((await getUser('u-rhea'))!.grants);
    const epoch = (await getUser('u-rhea'))!.epoch;
    await Promise.all([
      provisionAccess({ id: 'req-0001' }),
      // …and the admin saves their edit (adds approver) against the matrix they loaded.
      setGrants('u-rhea', { access: ['requester', 'approver'] }, { base: loaded }),
    ]);
    const after = (await getUser('u-rhea', { authoritative: true }))!;
    expect(after.grants).toEqual({ access: ['requester', 'approver'], orgiq: ['sme'] });
    // Neither an admin edit nor a provisioning bumps.
    expect(after.epoch).toBe(epoch);
    // The edit's removals are still applied: dropping approver against a base that holds it removes only it.
    await setGrants('u-rhea', { access: ['requester'] }, { base: { access: ['requester', 'approver'] } });
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'], orgiq: ['sme'] });
  });
});
