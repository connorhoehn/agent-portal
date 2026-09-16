// Scale audit fix: realGetLeaderboard (providers/aurora.ts) used to answer
// `total: entries.length` — the LIMIT page size — over a SQL query capped at
// 200 rows. The portal renders that number as "people scored", so a
// department with 842 scored people showed 200. This is the regression test
// against the REAL RDS Data API path (not the mock branch, which was never
// the bug): it drives realAurora.getLeaderboard through a mocked `send`,
// same harness as aurora-transaction.test.ts, and asserts the reported total
// comes from the count query, not from counting the page it shipped beside.

const send = jest.fn();

function col(name: string) {
  return { name };
}

function strCell(v: string | null) {
  return v == null ? { isNull: true } : { stringValue: v };
}
function numCell(v: number | null) {
  return v == null ? { isNull: true } : { doubleValue: v };
}
function longCell(v: number) {
  return { longValue: v };
}

jest.mock('@aws-sdk/client-rds-data', () => ({
  RDSDataClient: jest.fn().mockImplementation(() => ({ send })),
  ExecuteStatementCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Execute', input })),
  BeginTransactionCommand: jest.fn(),
  CommitTransactionCommand: jest.fn(),
  RollbackTransactionCommand: jest.fn(),
}));

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
  },
}));

import { realAurora } from '../aurora.js';

beforeEach(() => send.mockReset());

/** One scored-person row, shaped like the leaderboard SELECT's projection. */
function personRow(id: string) {
  return [
    strCell(id), strCell(`Person ${id}`), strCell('Platform'),
    numCell(10), numCell(20), numCell(30), strCell('2026-08-01T00:00:00Z'),
  ];
}

describe('realGetLeaderboard total', () => {
  it('reports the real COUNT(*), not the length of the LIMIT-ed page', async () => {
    // Page: 2 rows (as if LIMIT capped it there). Count: 842 people total —
    // the true population the department query matches, well past the page.
    send
      .mockResolvedValueOnce({
        columnMetadata: ['id', 'name', 'team', 'influence', 'expertise', 'composite', 'scored_at'].map(col),
        records: [personRow('p-001'), personRow('p-002')],
      })
      .mockResolvedValueOnce({
        columnMetadata: [col('n')],
        records: [[longCell(842)]],
      });

    const result = await realAurora.getLeaderboard({ limit: 2 });
    expect(result.entries).toHaveLength(2);
    // The whole point of the fix: fails against the old implementation,
    // which answered `total: entries.length` (2).
    expect(result.total).toBe(842);
    expect(result.total).not.toBe(result.entries.length);
  });

  it('scopes the count query with the SAME department filter as the page', async () => {
    send
      .mockResolvedValueOnce({
        columnMetadata: ['id', 'name', 'team', 'influence', 'expertise', 'composite', 'scored_at'].map(col),
        records: [personRow('p-001')],
      })
      .mockResolvedValueOnce({ columnMetadata: [col('n')], records: [[longCell(1)]] });

    await realAurora.getLeaderboard({ department: 'Platform', limit: 25 });
    const [pageCall, countCall] = send.mock.calls;
    const pageSql = String((pageCall![0] as { input: { sql: string } }).input.sql);
    const countSql = String((countCall![0] as { input: { sql: string } }).input.sql);
    expect(pageSql).toMatch(/WHERE \(:dept::text IS NULL/);
    expect(countSql).toMatch(/WHERE \(:dept::text IS NULL/);
    expect(countSql).toMatch(/count\(\*\)/);
    const countParams = (countCall![0] as { input: { parameters: Array<{ name: string; value: Record<string, unknown> }> } })
      .input.parameters;
    expect(countParams.find((p) => p.name === 'dept')!.value['stringValue']).toBe('Platform');
  });

  it('falls back to the page length only if the count query returns nothing usable', async () => {
    send
      .mockResolvedValueOnce({
        columnMetadata: ['id', 'name', 'team', 'influence', 'expertise', 'composite', 'scored_at'].map(col),
        records: [personRow('p-001')],
      })
      .mockResolvedValueOnce({ columnMetadata: [col('n')], records: [] });

    const result = await realAurora.getLeaderboard({});
    expect(result.total).toBe(result.entries.length);
  });
});
