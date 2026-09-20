const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn(() => ({ send: mockSend })), ExecuteStatementCommand: jest.fn(value => value),
}));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false }, aurora: { clusterArn: 'cluster', secretArn: 'secret', database: 'test' } } }));
import { getUser } from '../identity.js';
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
