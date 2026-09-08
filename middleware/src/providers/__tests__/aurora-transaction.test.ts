// REVIEW-2026-09-05 findings 4/8: commitSubmissions' Aurora branch used to
// read-then-supersede-then-insert as three separate autocommit statements
// with no transaction — a crash between supersede and insert left a
// submission permanently superseded with nothing replacing it. `exec` had
// no transaction primitive at all (grep confirms no other provider in this
// codebase uses BeginTransaction/CommitTransaction). This is the unit test
// for the new `withTransaction` helper itself (providers/aurora.ts):
// begins, threads the transactionId through every statement `fn` issues,
// commits on success, and rolls back (without masking the original error)
// when `fn` throws. assessment-aurora.ts's use of it (commitSubmissionEnvelope)
// is covered separately in assessment-commit-atomicity.test.ts.

const send = jest.fn();

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Execute', input })),
  BeginTransactionCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Begin', input })),
  CommitTransactionCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Commit', input })),
  RollbackTransactionCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Rollback', input })),
}));

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
  },
}));

import { withTransaction } from '../aurora.js';

function cmdsOf(): string[] {
  return send.mock.calls.map((c) => (c[0] as { __cmd: string }).__cmd);
}

beforeEach(() => send.mockReset());

describe('withTransaction', () => {
  it('begins, threads the transactionId into every statement fn issues, and commits on success', async () => {
    send
      .mockResolvedValueOnce({ transactionId: 'txn-abc' })       // BeginTransaction
      .mockResolvedValueOnce({ columnMetadata: [], records: [] }) // fn's first exec
      .mockResolvedValueOnce({ columnMetadata: [], records: [] }) // fn's second exec
      .mockResolvedValueOnce({});                                 // CommitTransaction

    const result = await withTransaction(async (tx) => {
      await tx('UPDATE a SET x = 1');
      await tx('INSERT INTO b VALUES (1)');
      return 'done';
    });

    expect(result).toBe('done');
    expect(cmdsOf()).toEqual(['Begin', 'Execute', 'Execute', 'Commit']);
    expect((send.mock.calls[1]![0] as { input: { transactionId: string } }).input.transactionId).toBe('txn-abc');
    expect((send.mock.calls[2]![0] as { input: { transactionId: string } }).input.transactionId).toBe('txn-abc');
    expect((send.mock.calls[3]![0] as { input: { transactionId: string } }).input.transactionId).toBe('txn-abc');
  });

  it('rolls back and re-throws the original error when fn throws, without ever committing', async () => {
    send
      .mockResolvedValueOnce({ transactionId: 'txn-xyz' }) // BeginTransaction
      .mockResolvedValueOnce({ columnMetadata: [], records: [] }) // fn's exec
      .mockResolvedValueOnce({}); // RollbackTransaction

    await expect(withTransaction(async (tx) => {
      await tx('UPDATE a SET x = 1');
      throw new Error('insert conflicted');
    })).rejects.toThrow('insert conflicted');

    expect(cmdsOf()).toEqual(['Begin', 'Execute', 'Rollback']);
  });

  it('a rollback failure never masks the original error', async () => {
    send
      .mockResolvedValueOnce({ transactionId: 'txn-fail' })
      .mockRejectedValueOnce(new Error('rollback also failed')); // RollbackTransaction throws

    await expect(withTransaction(async () => {
      throw new Error('the real failure');
    })).rejects.toThrow('the real failure');
  });

  it('throws before ever calling fn if BeginTransaction returns no transactionId', async () => {
    send.mockResolvedValueOnce({}); // no transactionId
    const fn = jest.fn();
    await expect(withTransaction(fn)).rejects.toThrow(/transactionId/);
    expect(fn).not.toHaveBeenCalled();
  });
});
