// Sprints provider — the SQL invariants the sprint board depends on.
//
// Pinned here: that "mine" is the three-way test the seed actually needs (the
// SME the demo logs in as stewards nothing), that window spend reuses the
// ledger's attribution predicate rather than a private copy, that the sprint
// window includes its final day, and that an account with no linked person
// cannot fall through to the whole org's board under a "mine" label.

jest.mock('../aurora.js', () => ({ exec: jest.fn(), fetchAvatarsById: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec, fetchAvatarsById } from '../aurora.js';
import { config } from '../../config.js';
import { spendPredicateSql, MOCK_GRANTS, mockInitiativeWindowSpendUsd } from '../budgets.js';
import { searchWorkItems } from '../work-items.js';
import {
  listSprints, isMine, SPRINT_STATUSES, createSprint, getSprint, personExists,
  _resetMockSprints, type SprintRow,
} from '../sprints.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  execMock.mockReset();
  execMock.mockResolvedValue([]);
  jest.mocked(fetchAvatarsById).mockReset().mockResolvedValue(new Map());
});

it('resolves portraits only for stewards on the returned sprint rows', async () => {
  execMock.mockResolvedValue([{ id: 'spr-a', steward_person_id: 'p-049', steward_name: 'Paolo Mancini' }]);
  jest.mocked(fetchAvatarsById).mockResolvedValue(new Map([['p-049', '/avatars/photos/p-049.jpg']]));
  const rows = await listSprints({ personId: 'p-049', mineOnly: true });
  expect(fetchAvatarsById).toHaveBeenCalledWith(['p-049']);
  expect(rows[0]?.stewardAvatarUrl).toBe('/avatars/photos/p-049.jpg');
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
      stewardAvatarUrl: null,
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
    // The work board's half is READ from the board, not restated here: a
    // hand-typed list of its sprint ids is the same copied-constant defect
    // this test exists to catch, one level up. It went stale the moment
    // work-items.ts mirrored the seed's p-llm-platform / p-inference-platform
    // / p-zero-trust rows and their sprints came with them.
    const known = new Set([
      ...MOCK_GRANTS.map((g) => g.sprintId),
      ...(await searchWorkItems({ limit: 1000 })).map((i) => i.sprintId).filter((s): s is string => s !== null),
    ]);
    for (const id of ids) expect(known.has(id)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('reads each envelope from the ledger\'s own grant fixture', async () => {
    for (const row of await listSprints()) {
      const grants = MOCK_GRANTS.filter((g) => g.sprintId === row.id);
      expect(row.grantCount).toBe(grants.length);
      expect(row.grantedUsd).toBe(grants.reduce((n, g) => n + g.allocatedUsd, 0));
      // Granted money is per-grant and sums. SPEND is not: it belongs to the
      // initiative over the sprint's window, counted once however many grants
      // the sprint carries — see the window-spend describe below.
      expect(row.initiativeSpendInWindowUsd)
        .toBeCloseTo(mockInitiativeWindowSpendUsd(row.orgProjectId, row.startsOn, row.endsOn), 2);
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

// ─── Writes ───────────────────────────────────────────────────────────────────

describe('createSprint (real)', () => {
  it('inserts with parameters and casts the dates, then reads back through getSprint', async () => {
    execMock
      .mockResolvedValueOnce([{ id: 'spr-new' }]) // INSERT ... RETURNING id
      .mockResolvedValueOnce([{ id: 'spr-new', org_project_id: 'p-observability', name: 'Sprint 99',
        status: 'planned', starts_on: '2026-09-01', ends_on: '2026-09-14' }]); // read-back

    const row = await createSprint({
      orgProjectId: 'p-observability', name: 'Sprint 99',
      startsOn: '2026-09-01', endsOn: '2026-09-14', stewardPersonId: 'p-008', goal: 'ship it',
    });

    const [sql, params] = execMock.mock.calls[0]!;
    expect(String(sql)).toMatch(/INSERT INTO sprints/);
    expect(String(sql)).toContain(':starts::date');
    expect(String(sql)).toContain(':ends::date');
    expect(params).toEqual(expect.arrayContaining([
      { name: 'pid', value: { stringValue: 'p-observability' } },
      { name: 'name', value: { stringValue: 'Sprint 99' } },
      { name: 'goal', value: { stringValue: 'ship it' } },
      { name: 'steward', value: { stringValue: 'p-008' } },
      { name: 'starts', value: { stringValue: '2026-09-01' } },
      { name: 'ends', value: { stringValue: '2026-09-14' } },
      { name: 'status', value: { stringValue: 'planned' } },
    ]));
    // The read-back is scoped to the new id.
    expect(String(execMock.mock.calls[1]![0])).toContain('sp.id = :sid');
    expect(row.id).toBe('spr-new');
  });

  it('nulls an omitted steward/goal instead of an empty string', async () => {
    execMock.mockResolvedValueOnce([{ id: 'spr-new' }]).mockResolvedValueOnce([{ id: 'spr-new' }]);
    await createSprint({ orgProjectId: 'p-x', name: 'S', startsOn: '2026-09-01', endsOn: '2026-09-14' });
    const params = execMock.mock.calls[0]![1] as Array<{ name: string; value: unknown }>;
    expect(params.find((p) => p.name === 'steward')!.value).toEqual({ isNull: true });
    expect(params.find((p) => p.name === 'goal')!.value).toEqual({ isNull: true });
  });

  it('throws loudly (not safeExec-swallowed) if the row cannot be read back', async () => {
    execMock.mockResolvedValueOnce([{ id: 'spr-new' }]).mockResolvedValueOnce([]);
    await expect(createSprint({ orgProjectId: 'p-x', name: 'S', startsOn: '2026-09-01', endsOn: '2026-09-14' }))
      .rejects.toThrow(/could not be read back/);
  });
});

describe('getSprint (real)', () => {
  it('scopes the board query to a single id', async () => {
    await getSprint('spr-obs-s3');
    expect(String(execMock.mock.calls.at(-1)![0])).toContain('sp.id = :sid');
    expect(execMock.mock.calls.at(-1)![1]).toEqual(
      expect.arrayContaining([{ name: 'sid', value: { stringValue: 'spr-obs-s3' } }]),
    );
  });
});

describe('personExists (real)', () => {
  it('is true when the people row exists, false otherwise', async () => {
    execMock.mockResolvedValueOnce([{ id: 'p-008' }]);
    expect(await personExists('p-008')).toBe(true);
    execMock.mockResolvedValueOnce([]);
    expect(await personExists('p-nope')).toBe(false);
  });
});

describe('createSprint (mock mode)', () => {
  beforeAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = true; });
  afterAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = false; });
  beforeEach(() => { _resetMockSprints(); });

  it('never touches Aurora and answers existence permissively', async () => {
    expect(await personExists('anyone')).toBe(true);
    await createSprint({ orgProjectId: 'p-observability', name: 'New', startsOn: '2026-09-01', endsOn: '2026-09-14' });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('creates a sprint that then appears on the board and reads back by id', async () => {
    const created = await createSprint({
      orgProjectId: 'p-observability', name: 'Sprint 99', startsOn: '2026-09-01', endsOn: '2026-09-14',
      stewardPersonId: 'p-008',
    });
    expect(created.status).toBe('planned');
    expect(created.startsOn).toBe('2026-09-01');
    const board = await listSprints();
    expect(board.some((s) => s.id === created.id)).toBe(true);
    expect((await getSprint(created.id))!.name).toBe('Sprint 99');
  });

  it('marks a created sprint as the steward\'s own via mineOnly', async () => {
    const created = await createSprint({
      orgProjectId: 'p-observability', name: 'Steered', startsOn: '2026-09-01', endsOn: '2026-09-14',
      stewardPersonId: 'p-008',
    });
    const mine = await listSprints({ personId: 'p-008', mineOnly: true });
    expect(mine.some((s) => s.id === created.id && s.isSteward)).toBe(true);
  });
});

// ─── window spend is the initiative's, counted once ──────────────────────────
//
// The SQL sums bot_runs for the initiative over the sprint window in ONE
// subquery, independent of how many grants the sprint carries. The mock used
// to add up each grant's own `initiativeSpendInWindowUsd`, so a sprint with
// two grants reported the same initiative's money twice — and reported a
// LIFETIME total, because a seeded grant carries no window bounds.
describe('mock sprint window spend', () => {
  beforeAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = true; });
  afterAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = false; });
  beforeEach(() => { _resetMockSprints(); });

  it('does not scale with grant count on a multi-grant sprint', async () => {
    const board = await listSprints();
    const multi = board.filter((s) => s.grantCount > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const s of multi) {
      const once = mockInitiativeWindowSpendUsd(s.orgProjectId, s.startsOn, s.endsOn);
      expect(s.initiativeSpendInWindowUsd).toBeCloseTo(once, 2);
      // The old bug: grantCount copies of the same money.
      const perGrantSum = MOCK_GRANTS
        .filter((g) => g.sprintId === s.id)
        .reduce((n, g) => n + g.initiativeSpendInWindowUsd, 0);
      if (perGrantSum > 0) expect(s.initiativeSpendInWindowUsd).toBeLessThan(perGrantSum);
    }
  });

  it('is bounded by the sprint window, not the initiative lifetime', async () => {
    const board = await listSprints();
    for (const s of board) {
      const lifetime = mockInitiativeWindowSpendUsd(s.orgProjectId, null, null);
      expect(s.initiativeSpendInWindowUsd).toBeLessThanOrEqual(lifetime + 1e-9);
    }
  });
});
