// The work item's brief — summary / blocked_reason / next_step /
// next_step_detail (schema/orgiq_work_items_schema.sql) — on both paths.
//
// Mock: the fixture carries the copy the Initiatives redesign renders for
// p-observability, and every other row is null (the parity harness pins the
// values against schema/seed_program.sql; this pins that they reach the wire
// shape at all).
//
// Aurora: the columns are read only when information_schema says all four
// exist. The point of the probe is that a cluster which has not run the ALTER
// keeps its Work tab — `column ... does not exist` is not a missing RELATION,
// so safeExec would not swallow it and the whole board would 500.

const mockConfig = { region: 'us-east-1', aurora: {}, mock: { aurora: true } };
jest.mock('../../config.js', () => ({ config: mockConfig }));

const execMock = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...args: unknown[]) => execMock(...args) }));

import { getWorkItem, resetBriefColumnsProbe, resetAppUsersProbe } from '../work-items.js';

const BRIEF_SQL = 'wi.summary, wi.blocked_reason, wi.next_step, wi.next_step_detail';

describe('brief fields — mock path', () => {
  beforeAll(() => { mockConfig.mock.aurora = true; });

  it('carries the blocked bug\'s whole brief', async () => {
    expect(await getWorkItem('wi-obs-e2-b4')).toMatchObject({
      title: 'Stop duplicate alerts during a dependency outage',
      summary: 'One failing dependency can trigger forty pages.',
      blockedReason: 'Eli needs the dependency map before this bug can be planned.',
      nextStep: 'Confirm the dependency map with Eli Garcia.',
      nextStepDetail: 'The team needs this before choosing how to group duplicate alerts.',
    });
  });

  it('gives the Plan-next rows their one-line summaries', async () => {
    const summaries = await Promise.all(
      ['wi-obs-e1-s4', 'wi-obs-e2-s3', 'wi-obs-e3-s1'].map(async (id) => (await getWorkItem(id))?.summary),
    );
    expect(summaries).toEqual([
      'Move remaining service metrics to OpenTelemetry.',
      "Make each team's remaining error budget visible.",
      'Define limits before new metrics increase storage costs.',
    ]);
  });

  it('is null — never blank, never invented — on an item without a brief', async () => {
    expect(await getWorkItem('wi-auth-e1-s1')).toMatchObject({
      summary: null, blockedReason: null, nextStep: null, nextStepDetail: null,
    });
  });
});

describe('brief fields — Aurora path', () => {
  beforeAll(() => { mockConfig.mock.aurora = false; });
  afterAll(() => { mockConfig.mock.aurora = true; });
  beforeEach(() => {
    execMock.mockReset();
    resetBriefColumnsProbe();
    resetAppUsersProbe();
  });

  const itemRow = {
    id: 'wi-obs-e2-b4', project_id: 'p-observability', project_name: 'Observability Platform',
    type: 'bug', title: 'Stop duplicate alerts during a dependency outage', status: 'open', priority: 'high',
    summary: 'One failing dependency can trigger forty pages.',
    blocked_reason: 'Eli needs the dependency map before this bug can be planned.',
    next_step: 'Confirm the dependency map with Eli Garcia.',
    next_step_detail: 'The team needs this before choosing how to group duplicate alerts.',
  };

  /** Route exec by what the SQL asks: the two probes, then the item read. */
  function aurora(briefColumns: string[] | Error) {
    execMock.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [{ ok: 1 }];
      if (sql.includes('information_schema.columns')) {
        if (briefColumns instanceof Error) throw briefColumns;
        return briefColumns.map((column_name) => ({ column_name }));
      }
      // Without the columns selected, Postgres cannot return them either.
      return [sql.includes(BRIEF_SQL) ? itemRow : {
        ...itemRow, summary: undefined, blocked_reason: undefined, next_step: undefined, next_step_detail: undefined,
      }];
    });
  }
  const itemSql = (): string =>
    String(execMock.mock.calls.map((c) => c[0] as string).find((s) => s.includes('FROM work_items wi')));

  it('selects and maps all four when the cluster has them', async () => {
    aurora(['summary', 'blocked_reason', 'next_step', 'next_step_detail']);
    const item = await getWorkItem('wi-obs-e2-b4');
    expect(itemSql()).toContain(BRIEF_SQL);
    expect(item).toMatchObject({
      summary: itemRow.summary,
      blockedReason: itemRow.blocked_reason,
      nextStep: itemRow.next_step,
      nextStepDetail: itemRow.next_step_detail,
    });
  });

  it('omits them — and still returns the item — when the ALTER has not run', async () => {
    aurora(['summary', 'blocked_reason']); // a half-applied cluster reads as "no brief"
    const item = await getWorkItem('wi-obs-e2-b4');
    expect(itemSql()).not.toContain('wi.summary');
    expect(item).toMatchObject({
      title: itemRow.title, summary: null, blockedReason: null, nextStep: null, nextStepDetail: null,
    });
  });

  it('treats a failed probe as "not there" rather than failing the read', async () => {
    aurora(new Error('AccessDenied'));
    const item = await getWorkItem('wi-obs-e2-b4');
    expect(itemSql()).not.toContain('wi.summary');
    expect(item?.id).toBe('wi-obs-e2-b4');
  });

  it('probes once per process', async () => {
    aurora(['summary', 'blocked_reason', 'next_step', 'next_step_detail']);
    await getWorkItem('wi-obs-e2-b4');
    await getWorkItem('wi-obs-e2-b4');
    const probes = execMock.mock.calls.filter((c) => String(c[0]).includes('information_schema.columns'));
    expect(probes).toHaveLength(1);
  });
});
