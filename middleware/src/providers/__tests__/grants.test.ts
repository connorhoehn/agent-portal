// Grants provider (providers/grants.ts) — the write side of budget_grants.
// Pinned here: the real INSERT/UPDATE/DELETE bind their inputs as parameters
// (never string-interpolated), and the dev:mock overlay creates, re-allocates
// and revokes in-memory without ever mutating the seed MOCK_GRANTS array.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { config } from '../../config.js';
import { MOCK_GRANTS } from '../budgets.js';
import {
  createGrant, updateGrantAmount, revokeGrant, listGrantsForSprint, getGrant, _resetMockGrants,
} from '../grants.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  execMock.mockReset();
  execMock.mockResolvedValue([{ id: 'bg-new' }]);
});

describe('real mode — parameterized writes', () => {
  it('inserts a grant binding every field as a parameter', async () => {
    const row = await createGrant({
      orgProjectId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008',
      amountUsd: 30, grantedBy: 'u-release', note: 'sprint 98',
    });
    const [sql, params] = execMock.mock.calls[0]!;
    expect(String(sql)).toMatch(/INSERT INTO budget_grants/);
    expect(String(sql)).toContain(':pid');
    expect(String(sql)).toContain(':amt');
    // amount is bound as a numeric parameter, never interpolated into SQL.
    expect(String(sql)).not.toContain('30');
    expect(params).toEqual(expect.arrayContaining([
      { name: 'pid', value: { stringValue: 'p-observability' } },
      { name: 'sprint', value: { stringValue: 'spr-obs-s3' } },
      { name: 'grantee', value: { stringValue: 'p-008' } },
      { name: 'amt', value: { doubleValue: 30 } },
      { name: 'by', value: { stringValue: 'u-release' } },
      { name: 'note', value: { stringValue: 'sprint 98' } },
    ]));
    expect(row.id).toBe('bg-new');
  });

  it('nulls an omitted grantedBy/note rather than binding an empty string', async () => {
    await createGrant({ orgProjectId: 'p-x', sprintId: 'spr-x', granteePersonId: 'p-1', amountUsd: 5 });
    const params = execMock.mock.calls[0]![1] as Array<{ name: string; value: unknown }>;
    expect(params.find((p) => p.name === 'by')!.value).toEqual({ isNull: true });
    expect(params.find((p) => p.name === 'note')!.value).toEqual({ isNull: true });
  });

  it('updates only the amount and touches updated_at', async () => {
    execMock.mockResolvedValue([{ id: 'bg-obs-3' }]); // UPDATE + read-back both hit this id
    const row = await updateGrantAmount('bg-obs-3', 45);
    const [sql, params] = execMock.mock.calls[0]!;
    expect(String(sql)).toMatch(/UPDATE budget_grants SET allocated_usd = :amt/);
    expect(String(sql)).toContain('updated_at = NOW()');
    expect(params).toEqual([
      { name: 'amt', value: { doubleValue: 45 } },
      { name: 'id', value: { stringValue: 'bg-obs-3' } },
    ]);
    expect(row).not.toBeNull();
  });

  it('returns null when the update matches no row', async () => {
    execMock.mockResolvedValueOnce([]); // UPDATE ... RETURNING → no rows
    expect(await updateGrantAmount('bg-ghost', 10)).toBeNull();
  });

  it('deletes by id and reports whether a row was removed', async () => {
    execMock.mockResolvedValueOnce([{ id: 'bg-obs-3' }]);
    expect(await revokeGrant('bg-obs-3')).toBe(true);
    const [sql, params] = execMock.mock.calls[0]!;
    expect(String(sql)).toMatch(/DELETE FROM budget_grants WHERE id = :id/);
    expect(params).toEqual([{ name: 'id', value: { stringValue: 'bg-obs-3' } }]);

    execMock.mockResolvedValueOnce([]);
    expect(await revokeGrant('bg-ghost')).toBe(false);
  });
});

// ─── Mock mode (dev:mock, no Aurora) ─────────────────────────────────────────

describe('mock mode', () => {
  beforeAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = true; });
  afterAll(() => { (config as { mock: { aurora: boolean } }).mock.aurora = false; });
  beforeEach(() => { _resetMockGrants(); });

  it('never touches Aurora', async () => {
    await createGrant({ orgProjectId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008', amountUsd: 12 });
    expect(execMock).not.toHaveBeenCalled();
  });

  it('creates a grant that then lists for its sprint, without mutating the seed', async () => {
    const seedLen = MOCK_GRANTS.length;
    const grant = await createGrant({
      orgProjectId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008', amountUsd: 12,
    });
    expect(grant.allocatedUsd).toBe(12);
    expect(grant.sprintId).toBe('spr-obs-s3');
    // The sprint join fills the initiative/sprint labels from the mock board.
    expect(grant.orgProjectName).toBe('Observability Platform');
    const forSprint = await listGrantsForSprint('spr-obs-s3');
    expect(forSprint.some((g) => g.id === grant.id)).toBe(true);
    // seed array is never mutated in place
    expect(MOCK_GRANTS.length).toBe(seedLen);
  });

  it('re-allocates a created grant in-memory', async () => {
    const grant = await createGrant({ orgProjectId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008', amountUsd: 12 });
    const patched = await updateGrantAmount(grant.id, 40);
    expect(patched!.allocatedUsd).toBe(40);
    expect((await getGrant(grant.id))!.allocatedUsd).toBe(40);
  });

  it('patches a seed grant through the overlay without touching MOCK_GRANTS', async () => {
    const seed = MOCK_GRANTS[0]!;
    const patched = await updateGrantAmount(seed.id, 999);
    expect(patched!.allocatedUsd).toBe(999);
    expect(seed.allocatedUsd).not.toBe(999); // the seed object is untouched
    expect((await getGrant(seed.id))!.allocatedUsd).toBe(999);
  });

  it('revokes a grant with a tombstone so it drops out of reads', async () => {
    const grant = await createGrant({ orgProjectId: 'p-observability', sprintId: 'spr-obs-s3', granteePersonId: 'p-008', amountUsd: 12 });
    expect(await revokeGrant(grant.id)).toBe(true);
    expect(await getGrant(grant.id)).toBeNull();
    const forSprint = await listGrantsForSprint('spr-obs-s3');
    expect(forSprint.some((g) => g.id === grant.id)).toBe(false);
  });

  it('revoking an unknown id reports false', async () => {
    expect(await revokeGrant('bg-nope')).toBe(false);
  });

  it('updating an unknown id returns null', async () => {
    expect(await updateGrantAmount('bg-nope', 10)).toBeNull();
  });
});
