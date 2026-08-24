// Sprints provider — the SQL invariants the sprint board depends on.
//
// Pinned here: that "mine" is the three-way test the seed actually needs (the
// SME the demo logs in as stewards nothing), that window spend reuses the
// ledger's attribution predicate rather than a private copy, that the sprint
// window includes its final day, and that an account with no linked person
// cannot fall through to the whole org's board under a "mine" label.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { config } from '../../config.js';
import { spendPredicateSql, MOCK_GRANTS } from '../budgets.js';
import { searchWorkItems } from '../work-items.js';
import { listSprints, isMine, SPRINT_STATUSES, type SprintRow } from '../sprints.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  execMock.mockReset();
  execMock.mockResolvedValue([]);
});

async function sql(opts: Parameters<typeof listSprints>[0] = {}): Promise<string> {
  await listSprints(opts);
  return String(execMock.mock.calls.at(-1)?.[0] ?? '');
}

/** Bound parameters of the LAST call, so two asserts can share one test. */
async function params(opts: Parameters<typeof listSprints>[0] = {}): Promise<unknown[]> {
  await listSprints(opts);
  return (execMock.mock.calls.at(-1)?.[1] ?? []) as unknown[];
}

describe('window spend', () => {
  it('reuses the ledger attribution predicate instead of re-deriving it', async () => {
    expect(await sql()).toContain(spendPredicateSql('sp.org_project_id'));
  });

  it('includes the sprint\'s final day', async () => {
    const s = await sql();
    // ends_on is a DATE; `<= ends_on` would compare against midnight and drop
    // the whole last day of the sprint — the day a demo is most likely on.
    expect(s).toContain('br.started_at >= sp.starts_on');
    expect(s).toContain('br.started_at < sp.ends_on + 1');
    expect(s).not.toContain('br.started_at <= sp.ends_on');
  });

  it('bounds spend by the sprint, not by the calendar month', async () => {
    expect(await sql()).not.toContain(`date_trunc('month', NOW())`);
  });
});

describe('"mine"', () => {
  it('counts stewardship, an envelope, or assigned work — any one of the three', async () => {
    const s = await sql({ personId: 'p-004', mineOnly: true });
    expect(s).toContain('sp.steward_person_id = :me');
    expect(s).toContain('g2.grantee_person_id = :me');
    expect(s).toContain('w2.assignee_id = :me');
    // The filter is a disjunction: p-004 stewards no sprint in the seed and
    // holds no grant, yet is assigned work in four — a steward-only test would
    // hand the SME an empty page.
    expect(s).toMatch(/WHERE \(sp\.steward_person_id = :me OR EXISTS[\s\S]*? > 0\)/);
  });

  it('binds the person once and only when there is one', async () => {
    expect(await params({ personId: 'p-004' })).toEqual([
      { name: 'me', value: { stringValue: 'p-004' } },
    ]);
    expect(await params({})).toEqual([]);
  });

  it('reports every marker false for an unlinked account rather than querying', async () => {
    const s = await sql({});
    expect(s).toContain('(FALSE) AS is_steward');
    expect(s).toContain('(FALSE) AS is_grantee');
    expect(s).toContain('0 AS my_item_count');
    expect(s).not.toContain(':me');
  });

  it('returns nothing — not everything — when an unlinked account asks for "mine"', async () => {
    // The dangerous failure is a `mineOnly` that silently degrades to no
    // filter, putting the org's whole board behind a "your sprints" heading.
    const s = await sql({ mineOnly: true });
    expect(s).toMatch(/WHERE FALSE/);
  });

  it('agrees with the row-level predicate the mock path filters on', () => {
    const base: SprintRow = {
      id: 'spr-x', orgProjectId: 'p-a', orgProjectName: 'A', name: 'S1', goal: null,
      stewardPersonId: null, stewardName: null, startsOn: null, endsOn: null, status: 'active',
      itemCount: 0, doneItemCount: 0, pointsTotal: 0, pointsDone: 0, estimatedCostUsd: 0,
      grantedUsd: 0, grantCount: 0, initiativeSpendInWindowUsd: 0,
      isSteward: false, isGrantee: false, myItemCount: 0, myOpenItemCount: 0,
    };
    expect(isMine(base)).toBe(false);
    expect(isMine({ ...base, isSteward: true })).toBe(true);
    expect(isMine({ ...base, isGrantee: true })).toBe(true);
    expect(isMine({ ...base, myItemCount: 1 })).toBe(true);
  });
});

describe('rollups', () => {
  it('counts every item in the sprint, not the page the board rendered', async () => {
    const s = await sql();
    expect(s).toContain('item_rollup AS (');
    expect(s).toContain(`COUNT(*) FILTER (WHERE w.status = 'done')`);
    expect(s).toContain(`SUM(w.story_points) FILTER (WHERE w.status = 'done')`);
    expect(s).toContain('SUM(w.estimated_cost_usd)');
  });

  it('sums the envelope from budget_grants scoped to the sprint', async () => {
    const s = await sql();
    expect(s).toContain('grant_rollup AS (');
    expect(s).toContain('SUM(g.allocated_usd)');
    expect(s).toContain('WHERE g.sprint_id IS NOT NULL');
  });

  it('maps a joined row through to the API shape', async () => {
    execMock.mockResolvedValue([{
      id: 'spr-obs-s3', org_project_id: 'p-observability', org_project_name: 'Observability Platform',
      name: 'Sprint 98', goal: 'RED dashboards', steward_person_id: 'p-008', steward_name: 'Layla Hassan',
      starts_on: '2026-08-10', ends_on: '2026-08-24', status: 'active',
      item_count: 5, done_item_count: 2, points_total: 21, points_done: 8, estimated_cost_usd: 31.07,
      granted_usd: 30, grant_count: 1, window_spend_usd: 2.74,
      is_steward: false, is_grantee: false, my_item_count: 1, my_open_item_count: 1,
    }]);
    const [row] = await listSprints({ personId: 'p-004' });
    expect(row).toEqual({
      id: 'spr-obs-s3', orgProjectId: 'p-observability', orgProjectName: 'Observability Platform',
      name: 'Sprint 98', goal: 'RED dashboards', stewardPersonId: 'p-008', stewardName: 'Layla Hassan',
      startsOn: '2026-08-10', endsOn: '2026-08-24', status: 'active',
      itemCount: 5, doneItemCount: 2, pointsTotal: 21, pointsDone: 8, estimatedCostUsd: 31.07,
      grantedUsd: 30, grantCount: 1, initiativeSpendInWindowUsd: 2.74,
      isSteward: false, isGrantee: false, myItemCount: 1, myOpenItemCount: 1,
    });
  });
});

describe('filters and ordering', () => {
  it('offers the schema\'s three statuses and no others', () => {
    expect([...SPRINT_STATUSES]).toEqual(['planned', 'active', 'done']);
  });

  it('leads with active sprints, then the most recently started', async () => {
    expect(await sql()).toContain(`ORDER BY (sp.status = 'active') DESC, sp.starts_on DESC`);
  });

  it('scopes by status and initiative as bound parameters', async () => {
    await listSprints({ status: 'active', orgProjectId: 'p-observability' });
    expect(String(execMock.mock.calls[0]?.[0])).toContain('WHERE sp.status = :status AND sp.org_project_id = :pid');
    expect(execMock.mock.calls[0]?.[1]).toEqual([
      { name: 'status', value: { stringValue: 'active' } },
      { name: 'pid', value: { stringValue: 'p-observability' } },
    ]);
  });

  it('clamps the limit rather than trusting the query string', async () => {
    expect(await sql({ limit: 99_999 })).toContain('LIMIT 300');
    expect(await sql({ limit: -5 })).toContain('LIMIT 1');
  });
});

// ─── Mock mode (dev:mock, no Aurora) ─────────────────────────────────────────
// The flag is read per call, so flipping it here exercises the same module.

describe('mock mode', () => {
  beforeAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = true; });
  afterAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = false; });

  it('never touches Aurora', async () => {
    await listSprints();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('only names sprints the rest of mock mode also knows', async () => {
    // Every fixture sprint must be one the mock work board or the mock grants
    // table already references — a sprint no other surface has heard of is a
    // demo that contradicts itself.
    const ids = (await listSprints()).map((s) => s.id);
    const known = new Set([
      ...MOCK_GRANTS.map((g) => g.sprintId),
      'spr-obs-s1', 'spr-obs-s2', 'spr-obs-s3', // providers/work-items.ts MOCK_PROGRAM_FIELDS
    ]);
    for (const id of ids) expect(known.has(id)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('reads each envelope from the ledger\'s own grant fixture', async () => {
    for (const row of await listSprints()) {
      const grants = MOCK_GRANTS.filter((g) => g.sprintId === row.id);
      expect(row.grantCount).toBe(grants.length);
      expect(row.grantedUsd).toBe(grants.reduce((n, g) => n + g.allocatedUsd, 0));
      expect(row.initiativeSpendInWindowUsd)
        .toBe(grants.reduce((n, g) => n + g.initiativeSpendInWindowUsd, 0));
    }
  });

  it('derives points and item counts from the mock work board', async () => {
    const row = (await listSprints()).find((s) => s.id === 'spr-obs-s3')!;
    const items = await searchWorkItems({ sprintId: 'spr-obs-s3', limit: 200 });
    expect(row.itemCount).toBe(items.length);
    expect(row.itemCount).toBeGreaterThan(0);
    expect(row.pointsTotal).toBe(items.reduce((n, i) => n + (i.storyPoints ?? 0), 0));
    expect(row.pointsDone).toBeLessThanOrEqual(row.pointsTotal);
  });

  it('leads with active sprints and honours the status filter', async () => {
    const all = await listSprints();
    expect(all[0]!.status).toBe('active');
    const active = await listSprints({ status: 'active' });
    expect(active.every((s) => s.status === 'active')).toBe(true);
    expect(active.length).toBeLessThan(all.length);
  });

  it('marks a steward\'s own sprints and filters to them', async () => {
    const mine = await listSprints({ personId: 'p-008', mineOnly: true });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((s) => s.isSteward || s.isGrantee || s.myItemCount > 0)).toBe(true);
    expect(mine.some((s) => s.id === 'spr-obs-s3')).toBe(true);
  });

  it('gives the demo SME a sprint through assigned work, not stewardship', async () => {
    // u-nora → p-004 stewards nothing and holds no envelope in either the seed
    // or the fixtures; she is assigned wi-k8s-s6 in spr-obs-s3. If "mine" ever
    // narrows to stewardship this goes empty, which is the whole defect the
    // three-way test exists to avoid.
    const mine = await listSprints({ personId: 'p-004', mineOnly: true });
    expect(mine.map((s) => s.id)).toContain('spr-obs-s3');
    const row = mine.find((s) => s.id === 'spr-obs-s3')!;
    expect(row.isSteward).toBe(false);
    expect(row.isGrantee).toBe(false);
    expect(row.myItemCount).toBeGreaterThan(0);
  });

  it('hands an unlinked account nothing rather than the whole board', async () => {
    expect(await listSprints({ personId: null, mineOnly: true })).toEqual([]);
    expect((await listSprints({ personId: null })).length).toBeGreaterThan(0);
  });
});

describe('schema tolerance', () => {
  it('renders an empty board on a cluster that predates program_schema.sql', async () => {
    execMock.mockRejectedValue(new Error('relation "sprints" does not exist'));
    await expect(listSprints()).resolves.toEqual([]);
  });

  it('still throws on a real failure', async () => {
    execMock.mockRejectedValue(new Error('connection reset'));
    await expect(listSprints()).rejects.toThrow('connection reset');
  });
});
