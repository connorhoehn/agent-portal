// Same bug class as aurora-leaderboard-total.test.ts, same fix, one level
// over: realGetSkillLeaderboard used to answer `total: entries.length` — the
// LIMIT page size — over a query capped at 100 rows. A skill held by more
// than `limit` people reported its page size as the holder count. This is
// the regression test against the REAL RDS Data API path (the mock branch
// was never the bug — see scores-seed-agreement.test.ts, which pins the
// mock's own, deliberately different, `total` contract).

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

/** One scored-person row, shaped like the skill-leaderboard SELECT's projection. */
function personRow(id: string) {
  return [
    strCell(id), strCell(`Person ${id}`), strCell('Platform'),
    numCell(10), numCell(20), numCell(30), strCell('2026-08-01T00:00:00Z'),
    numCell(4),
  ];
}

describe('realGetSkillLeaderboard total', () => {
  it('reports the real COUNT(DISTINCT ...), not the length of the LIMIT-ed page', async () => {
    // Page: 2 rows (as if LIMIT capped it there). Count: 140 holders of this
    // skill org-wide — well past the page.
    send
      .mockResolvedValueOnce({
        columnMetadata: ['id', 'name', 'team', 'influence', 'expertise', 'composite', 'scored_at', 'skill_strength'].map(col),
        records: [personRow('p-001'), personRow('p-002')],
      })
      .mockResolvedValueOnce({
        columnMetadata: [col('n')],
        records: [[longCell(140)]],
      });

    const result = await realAurora.getSkillLeaderboard({ skill: 'Kubernetes', limit: 2 });
    expect(result.entries).toHaveLength(2);
    // The whole point of the fix: fails against the old implementation,
    // which answered `total: entries.length` (2).
    expect(result.total).toBe(140);
    expect(result.total).not.toBe(result.entries.length);
  });

  it('scopes the count query with the SAME skill filter as the page', async () => {
    send
      .mockResolvedValueOnce({
        columnMetadata: ['id', 'name', 'team', 'influence', 'expertise', 'composite', 'scored_at', 'skill_strength'].map(col),
        records: [personRow('p-001')],
      })
      .mockResolvedValueOnce({ columnMetadata: [col('n')], records: [[longCell(1)]] });

    await realAurora.getSkillLeaderboard({ skill: 'Rust', limit: 25 });
    const [pageCall, countCall] = send.mock.calls;
    const pageSql = String((pageCall![0] as { input: { sql: string } }).input.sql);
    const countSql = String((countCall![0] as { input: { sql: string } }).input.sql);
    expect(pageSql).toMatch(/WHERE LOWER\(s\.name\) = LOWER\(:skill\)/);
    expect(countSql).toMatch(/WHERE LOWER\(s\.name\) = LOWER\(:skill\)/);
    expect(countSql).toMatch(/count\(DISTINCT p\.id\)/);
    const countParams = (countCall![0] as { input: { parameters: Array<{ name: string; value: Record<string, unknown> }> } })
      .input.parameters;
    expect(countParams.find((p) => p.name === 'skill')!.value['stringValue']).toBe('Rust');
  });

  it('falls back to the page length only if the count query returns nothing usable', async () => {
    send
      .mockResolvedValueOnce({
        columnMetadata: ['id', 'name', 'team', 'influence', 'expertise', 'composite', 'scored_at', 'skill_strength'].map(col),
        records: [personRow('p-001')],
      })
      .mockResolvedValueOnce({ columnMetadata: [col('n')], records: [] });

    const result = await realAurora.getSkillLeaderboard({ skill: 'Kubernetes' });
    expect(result.total).toBe(result.entries.length);
  });
});
