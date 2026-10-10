const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn(() => ({ send: mockSend })), ExecuteStatementCommand: jest.fn(value => value),
}));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false }, aurora: { clusterArn: 'cluster', secretArn: 'secret', database: 'test' } } }));
import { getUser, listUsers } from '../identity.js';
import { config } from '../../config.js';

beforeEach(() => { mockSend.mockReset(); Object.assign(config.mock, { aurora: false }); });
it('does not revive a deleted seed identity when the database returns no rows', async () => {
  mockSend.mockResolvedValue({ records: [] });
  expect(await getUser('u-jonas', { authoritative: true })).toBeNull();
});
it('does not fall back to seed grants during a database outage', async () => {
  mockSend.mockRejectedValue(new Error('database down'));
  await expect(getUser('u-jonas', { authoritative: true })).rejects.toThrow('database down');
});
it('uses fixture authority only in an explicitly mocked deployment', async () => {
  Object.assign(config.mock, { aurora: true });
  expect((await getUser('u-jonas', { authoritative: true }))?.id).toBe('u-jonas');
  expect(mockSend).not.toHaveBeenCalled();
});
it('does not expose a seed roster when an authoritative directory is empty or unavailable', async () => {
  mockSend.mockResolvedValueOnce({ records: [] });
  expect(await listUsers({ authoritative: true })).toEqual([]);
  mockSend.mockRejectedValueOnce(new Error('directory down'));
  await expect(listUsers({ authoritative: true })).rejects.toThrow('directory down');
});
it('preserves ordinary list fallback and explicit mock roster behavior', async () => {
  mockSend.mockRejectedValueOnce(new Error('directory down'));
  expect((await listUsers()).length).toBeGreaterThan(0);
  Object.assign(config.mock, { aurora: true });
  expect((await listUsers({ authoritative: true })).length).toBeGreaterThan(0);
});

const field = (value: unknown) => value === null ? { isNull: true } : typeof value === 'number' ? { longValue: value } : { stringValue: value };
it('keeps neighboring subjects, epochs and multi-tenant grants separate in a concurrent directory read', async () => {
  mockSend.mockResolvedValue({ records: [
    ['u-a', 'Alice', null, null, 4, null, 'orgiq', 'member'],
    ['u-a', 'Alice', null, null, 4, null, 'social', 'participant'],
    ['u-b', 'Bob', null, null, 9, 'external-b', 'social', 'moderator'],
    ['u-empty', 'Grantless', null, null, 2, null, null, null],
  ].map(row => row.map(field)) });
  const [alice, bob, empty, missing] = await Promise.all(['u-a', 'u-b', 'u-empty', 'u-missing'].map(id => getUser(id, { authoritative: true })));
  expect(alice).toMatchObject({ id: 'u-a', epoch: 4, grants: { orgiq: ['member'], social: ['participant'] } });
  expect(bob).toMatchObject({ id: 'u-b', epoch: 9, externalSub: 'external-b', grants: { social: ['moderator'] } });
  expect(empty?.grants).toEqual({}); expect(missing).toBeNull();
  alice!.grants.social!.push('admin');
  expect(bob!.grants.social).toEqual(['moderator']);
});
it('a completed authority read cannot revive a subject removed before the next action', async () => {
  mockSend.mockResolvedValueOnce({ records: [['u-a', 'Alice', null, null, 4, null, 'social', 'participant'].map(field)] });
  expect((await getUser('u-a', { authoritative: true }))?.epoch).toBe(4);
  mockSend.mockResolvedValueOnce({ records: [] });
  expect(await getUser('u-a', { authoritative: true })).toBeNull();
});
it('directory failure rejects every affected concurrent read without seeded fallback', async () => {
  mockSend.mockRejectedValueOnce(new Error('directory offline'));
  const results = await Promise.allSettled(['u-jonas', 'u-operator'].map(id => getUser(id, { authoritative: true })));
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
});
