// The demo sign-in cast (the seed mirror, an all-tenant admin among it) exists
// only offline: MOCK_AURORA or INSECURE_DEV_MODE. A deployed process whose
// identity tables are empty or unreachable answers with nobody, so neither the
// SSO email link nor any lookup can land on a demo account.
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn(() => ({ send: mockSend })), ExecuteStatementCommand: jest.fn(value => value),
}));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false }, aurora: { clusterArn: 'cluster', secretArn: 'secret', database: 'test' } } }));
import { demoDirectoryAllowed, getUser, getUserByEmail, listUsers, seedUserForPerson } from '../identity.js';
import { config } from '../../config.js';

const prior = { flag: process.env['INSECURE_DEV_MODE'], node: process.env['NODE_ENV'], rls: process.env['RLS_ENFORCE'] };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeAll(() => { process.env['RLS_ENFORCE'] = 'false'; });
afterAll(() => { restore('INSECURE_DEV_MODE', prior.flag); restore('NODE_ENV', prior.node); restore('RLS_ENFORCE', prior.rls); });
beforeEach(() => { mockSend.mockReset(); Object.assign(config.mock, { aurora: false }); });

describe('outside dev mode (a deployed process)', () => {
  beforeEach(() => { delete process.env['INSECURE_DEV_MODE']; process.env['NODE_ENV'] = 'production'; });

  it('the gate is closed', () => {
    expect(demoDirectoryAllowed()).toBe(false);
  });

  it('an empty or unreachable directory lists nobody', async () => {
    mockSend.mockResolvedValueOnce({ records: [] });
    expect(await listUsers()).toEqual([]);
    mockSend.mockRejectedValueOnce(new Error('directory down'));
    expect(await listUsers()).toEqual([]);
  });

  it('no demo account resolves by id, by email or by person', async () => {
    mockSend.mockRejectedValue(new Error('directory down'));
    expect(await getUser('u-operator')).toBeNull();
    expect(await getUserByEmail('operator@orgiq.example')).toBeNull();
    mockSend.mockResolvedValue({ records: [] });
    expect(await getUserByEmail('operator@orgiq.example')).toBeNull();
    expect(seedUserForPerson('p-030')).toBeNull();
  });

  it('a flag set in production does not open it either', async () => {
    process.env['INSECURE_DEV_MODE'] = 'true';
    expect(demoDirectoryAllowed()).toBe(false);
    mockSend.mockRejectedValue(new Error('directory down'));
    expect(await getUser('u-operator')).toBeNull();
  });
});

describe('local runs keep the demo cast', () => {
  it('under INSECURE_DEV_MODE', async () => {
    process.env['INSECURE_DEV_MODE'] = 'true';
    process.env['NODE_ENV'] = 'test';
    mockSend.mockRejectedValue(new Error('directory down'));
    expect((await getUser('u-operator'))?.id).toBe('u-operator');
  });

  it('under MOCK_AURORA', async () => {
    delete process.env['INSECURE_DEV_MODE'];
    process.env['NODE_ENV'] = 'test';
    Object.assign(config.mock, { aurora: true });
    expect(demoDirectoryAllowed()).toBe(true);
    expect((await listUsers({ authoritative: true })).length).toBeGreaterThan(0);
  });
});
