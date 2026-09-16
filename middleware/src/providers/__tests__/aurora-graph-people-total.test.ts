// Scale audit fix: fetchAllPeople (providers/aurora.ts) used to SELECT every
// row in `people` with no LIMIT at all, and none of the three graph snapshots
// (fetchGraph / fetchSkillsGraph / fetchProjectsGraph) told a caller how many
// people the graph actually holds versus how many it shipped. fetchAllPeople
// now applies a bounded circuit-breaker LIMIT (PEOPLE_GRAPH_LIMIT), and each
// snapshot carries `peopleTotal` from a real COUNT(*) run alongside it — this
// is the regression test against the REAL RDS Data API path, driven through
// a `send` mock that discriminates by SQL text rather than call order (the
// three snapshots issue several exec calls each, in an order this test
// should not have to know).

const send = jest.fn();

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

function col(name: string) {
  return { name };
}
function str(v: string) {
  return { stringValue: v };
}
function long(v: number) {
  return { longValue: v };
}
function num(v: number) {
  return { doubleValue: v };
}
function empty() {
  return { columnMetadata: [], records: [] };
}

/** Two people, as if a 500-row LIMIT had already capped a much larger table. */
const PEOPLE_PAGE = {
  columnMetadata: ['id', 'name', 'title', 'team', 'influence'].map(col),
  records: [
    [str('p-001'), str('Ada'), str('Engineer'), str('Platform'), num(0.5)],
    [str('p-002'), str('Bo'), str('Engineer'), str('Platform'), num(0.5)],
  ],
};
/** The TRUE population behind that page — far past what got shipped. */
const PEOPLE_COUNT = { columnMetadata: [col('n')], records: [[long(3417)]] };

function sqlOf(callArgs: unknown[]): string {
  return String((callArgs[0] as { input: { sql: string } }).input.sql);
}

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (cmd: { input: { sql: string } }) => {
    const sql = cmd.input.sql;
    if (/SELECT count\(\*\)::int AS n\s+FROM people/.test(sql)) return PEOPLE_COUNT;
    if (/FROM people\b/.test(sql) && /LIMIT :lim/.test(sql)) return PEOPLE_PAGE;
    // Every other query this run touches (skills join, edge tables, taxonomy
    // joins) is irrelevant to peopleTotal — answer empty rather than
    // enumerate every shape.
    return empty();
  });
});

describe('peopleTotal on the three graph snapshots (real path)', () => {
  it('fetchGraph reports the TRUE population, not nodes.length', async () => {
    const snap = await realAurora.fetchGraph();
    expect(snap.nodes).toHaveLength(2);
    expect(snap.peopleTotal).toBe(3417);
    expect(snap.peopleTotal).not.toBe(snap.nodes.length);
  });

  it('fetchSkillsGraph reports the TRUE population, not people.length', async () => {
    const snap = await realAurora.fetchSkillsGraph();
    expect(snap.people).toHaveLength(2);
    expect(snap.peopleTotal).toBe(3417);
  });

  it('fetchProjectsGraph reports the TRUE population, not people.length', async () => {
    const snap = await realAurora.fetchProjectsGraph();
    expect(snap.people).toHaveLength(2);
    expect(snap.peopleTotal).toBe(3417);
  });

  it('the people page query itself carries a bounded LIMIT', async () => {
    await realAurora.fetchGraph();
    const pageCall = send.mock.calls.find((c) => /LIMIT :lim/.test(sqlOf(c)) && /FROM people\b/.test(sqlOf(c)));
    expect(pageCall).toBeDefined();
    const lim = (pageCall![0] as { input: { parameters: Array<{ name: string; value: Record<string, unknown> }> } })
      .input.parameters.find((p) => p.name === 'lim')!.value['longValue'];
    expect(lim).toBeGreaterThan(0);
    expect(lim).toBeLessThanOrEqual(2000); // a real, finite circuit breaker
  });
});
