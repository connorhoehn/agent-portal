jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
import { config } from '../../config.js';
import { exec } from '../aurora.js';
import { createSavedSearch, deleteSavedSearch, listSavedSearches, savedSearchesFixture, updateSavedSearch } from '../saved-searches.js';
const owner = { sub: 'user-a', tenant: 'orgiq' };
const input = { name: 'Auth migration', query: 'Who can help?', scope: 'p-auth', types: ['initiative'], tab: 'connections' as const, selectedKeys: ['initiative:p-auth'] };
beforeEach(() => { savedSearchesFixture.rows().splice(0); (config.mock as { aurora: boolean }).aurora = true; (exec as jest.Mock).mockReset(); });
it('isolates saves and mutations by both user and tenant', async () => {
  const saved = await createSavedSearch(owner, input);
  expect(await listSavedSearches(owner)).toEqual([saved]);
  for (const other of [{ ...owner, sub: 'user-b' }, { ...owner, tenant: 'assessment' }]) {
    expect(await listSavedSearches(other)).toEqual([]);
    expect(await updateSavedSearch(other, saved.id, { name: 'stolen' })).toBeNull();
    expect(await deleteSavedSearch(other, saved.id)).toBe(false);
  }
  expect((await updateSavedSearch(owner, saved.id, { name: 'Renamed' }))?.name).toBe('Renamed');
  expect(await deleteSavedSearch(owner, saved.id)).toBe(true);
});
it('does not expose ownership or allow caller array mutation', async () => {
  const saved = await createSavedSearch(owner, input); saved.types.push('person');
  const stored = (await listSavedSearches(owner))[0]!;
  expect(stored.types).toEqual(['initiative']);
  expect(stored).not.toHaveProperty('ownerSub'); expect(stored).not.toHaveProperty('tenant');
});
it('binds user/tenant and malicious IDs in every real mutation', async () => {
  (config.mock as { aurora: boolean }).aurora = false; (exec as jest.Mock).mockResolvedValue([]);
  const malicious = "' OR true --";
  await updateSavedSearch(owner, malicious, { name: 'Updated' }); await deleteSavedSearch(owner, malicious); await listSavedSearches(owner);
  for (const [sql, params] of (exec as jest.Mock).mock.calls) {
    expect(sql).toContain('owner_sub = :owner'); expect(sql).toContain('tenant_id = :tenant'); expect(sql).not.toContain(malicious);
    expect(params).toEqual(expect.arrayContaining([{ name: 'owner', value: { stringValue: owner.sub } }, { name: 'tenant', value: { stringValue: owner.tenant } }]));
  }
});
