// userStewardsInitiative: the steward rule for a service-signed call that
// names the user it acts for (internal-devbox POST /sessions).

const users = new Map<string, unknown>();
const getUser = jest.fn(async (id: string, _options?: unknown) => (users.has(id) ? structuredClone(users.get(id)) : null));
jest.mock('../../providers/identity.js', () => ({ getUser: (id: string, options: unknown) => getUser(id, options) }));
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => id === 'p-auth-migration'
    ? { id, ownerId: 'p-001', contributors: [{ personId: 'p-002' }] }
    : null),
}));

import { userStewardsInitiative } from '../initiative-scope.js';

function user(id: string, personId: string | null, grants: Record<string, string[]>) {
  users.set(id, { id, displayName: id, email: null, personId, epoch: 0, externalSub: null, grants });
}

beforeEach(() => {
  users.clear();
  getUser.mockClear();
  user('u-owner', 'p-001', { orgiq: ['program-owner'] });
  user('u-contrib', 'p-002', { orgiq: ['sme'] });
  user('u-stranger', 'p-003', { orgiq: ['sme'] });
  user('u-leader', null, { orgiq: ['org-leader'] });
  user('u-admin', null, { social: ['admin'] });
  user('u-unlinked', null, { orgiq: ['sme'] });
});

describe('userStewardsInitiative', () => {
  it('allows the owner and a contributor, and reads the directory authoritatively', async () => {
    await expect(userStewardsInitiative('u-owner', 'p-auth-migration')).resolves.toBe(true);
    await expect(userStewardsInitiative('u-contrib', 'p-auth-migration')).resolves.toBe(true);
    expect(getUser).toHaveBeenCalledWith('u-owner', { authoritative: true });
  });

  it('lets an org-wide role held in any tenant through without membership', async () => {
    await expect(userStewardsInitiative('u-leader', 'p-auth-migration')).resolves.toBe(true);
    await expect(userStewardsInitiative('u-admin', 'p-auth-migration')).resolves.toBe(true);
  });

  it('denies a stranger, an unlinked user, an unknown user and an unknown initiative', async () => {
    await expect(userStewardsInitiative('u-stranger', 'p-auth-migration')).resolves.toBe(false);
    await expect(userStewardsInitiative('u-unlinked', 'p-auth-migration')).resolves.toBe(false);
    await expect(userStewardsInitiative('u-nobody', 'p-auth-migration')).resolves.toBe(false);
    await expect(userStewardsInitiative('u-owner', 'p-missing')).resolves.toBe(false);
  });

  it('denies when the directory read fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    getUser.mockRejectedValueOnce(new Error('identity store unavailable'));
    await expect(userStewardsInitiative('u-leader', 'p-auth-migration')).resolves.toBe(false);
    warn.mockRestore();
  });
});
