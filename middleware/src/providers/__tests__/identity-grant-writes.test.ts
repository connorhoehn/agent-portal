// The cluster half of the grant writers (providers/identity.ts), on the Data
// API wire: every write names (user, tenant, role) rows; a whole-set write is
// a diff inside ONE transaction (begin, per-role statements carrying its id,
// commit — rollback on failure); no writer deletes a user's whole set; none
// bumps the epoch. The statements' behaviour under real concurrency is the
// native PostgreSQL contract (lib/access/__tests__/access-postgres.test.ts).
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn(() => ({ send: mockSend })),
  ExecuteStatementCommand: jest.fn((value) => ({ kind: 'exec', ...value })),
  BeginTransactionCommand: jest.fn((value) => ({ kind: 'begin', ...value })),
  CommitTransactionCommand: jest.fn((value) => ({ kind: 'commit', ...value })),
  RollbackTransactionCommand: jest.fn((value) => ({ kind: 'rollback', ...value })),
}));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false }, aurora: { clusterArn: 'cluster', secretArn: 'secret', database: 'test' } } }));
import { grantRole, revokeRole, setGrants } from '../identity.js';
import { GRANT_ROLE_SQL, REVOKE_ROLE_SQL, USER_GRANTS_SQL } from '../../lib/identity-grants-sql.js';

type Sent = { kind: string; sql?: string; transactionId?: string; parameters?: Array<{ name: string; value: { stringValue: string } }> };
const sent = (): Sent[] => mockSend.mock.calls.map(([c]) => c as Sent);
const params = (c: Sent) => Object.fromEntries((c.parameters ?? []).map((p) => [p.name, p.value.stringValue]));
const rows = (pairs: Array<[string, string]>) => ({ records: pairs.map(([t, r]) => [{ stringValue: t }, { stringValue: r }]) });

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockImplementation(async (c: Sent) => (c.kind === 'begin' ? { transactionId: 'tx-1' } : { records: [] }));
});

it('grantRole / revokeRole write exactly one row, outside any transaction, with no epoch bump', async () => {
  await grantRole('u-rhea', 'orgiq', 'sme');
  await revokeRole('u-rhea', 'orgiq', 'budgets-reader');
  expect(sent().map((c) => [c.kind, c.sql, params(c)])).toEqual([
    ['exec', GRANT_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'sme' }],
    ['exec', REVOKE_ROLE_SQL, { user_id: 'u-rhea', tenant: 'orgiq', role: 'budgets-reader' }],
  ]);
  expect(sent().some((c) => /session_epoch/.test(c.sql ?? ''))).toBe(false);
});

it('setGrants with the editor\'s base applies only the diff, in one transaction', async () => {
  await setGrants('u-rhea', { access: ['requester', 'approver'] }, { base: { access: ['requester'], orgiq: ['member'] } });
  expect(sent().map((c) => [c.kind, c.sql ?? null, c.transactionId ?? null, params(c)])).toEqual([
    ['begin', null, null, {}],
    ['exec', REVOKE_ROLE_SQL, 'tx-1', { user_id: 'u-rhea', tenant: 'orgiq', role: 'member' }],
    ['exec', GRANT_ROLE_SQL, 'tx-1', { user_id: 'u-rhea', tenant: 'access', role: 'approver' }],
    ['commit', null, 'tx-1', {}],
  ]);
});

it('setGrants with no base reads the rows inside the transaction and diffs against them', async () => {
  mockSend.mockImplementation(async (c: Sent) => (c.kind === 'begin' ? { transactionId: 'tx-1' }
    : c.sql === USER_GRANTS_SQL ? rows([['access', 'requester'], ['orgiq', 'sme']]) : { records: [] }));
  await setGrants('u-rhea', { access: ['requester'], orgiq: ['budgets-reader'] });
  expect(sent().map((c) => [c.kind, c.sql ?? null, c.transactionId ?? null])).toEqual([
    ['begin', null, null],
    ['exec', USER_GRANTS_SQL, 'tx-1'],
    ['exec', REVOKE_ROLE_SQL, 'tx-1'],
    ['exec', GRANT_ROLE_SQL, 'tx-1'],
    ['commit', null, 'tx-1'],
  ]);
  // Never the old whole-set delete.
  expect(sent().some((c) => /DELETE FROM user_tenant_roles WHERE user_id = :id\s*$/.test(c.sql ?? ''))).toBe(false);
});

it('a failed statement rolls the transaction back and rethrows', async () => {
  mockSend.mockImplementation(async (c: Sent) => {
    if (c.kind === 'begin') return { transactionId: 'tx-1' };
    if (c.sql === GRANT_ROLE_SQL) throw new Error('fk violation');
    return { records: [] };
  });
  await expect(setGrants('u-rhea', { orgiq: ['sme'] }, { base: {} })).rejects.toThrow('fk violation');
  expect(sent().map((c) => c.kind)).toEqual(['begin', 'exec', 'rollback']);
});

it('an unchanged matrix writes nothing but the empty transaction', async () => {
  await setGrants('u-rhea', { access: ['requester'] }, { base: { access: ['requester'] } });
  expect(sent().map((c) => c.kind)).toEqual(['begin', 'commit']);
});
