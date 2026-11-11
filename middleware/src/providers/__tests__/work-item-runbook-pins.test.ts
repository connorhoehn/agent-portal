// work_items.runbook_pins (schema/orgiq_work_items_schema.sql) on both paths:
// the runbooks a person pinned to an item, in order (docs/learning-loop-design.md
// stage 4).
//
// Mock: the registered fixture row carries them, [] by default, and a reset
// takes a pin back. Aurora: the read projects them through to_jsonb (null, so
// [], on a cluster without the column); the write probes for the column first
// and answers 'unavailable' rather than failing on a missing column.

const mockConfig = { region: 'us-east-1', aurora: {}, mock: { aurora: true } };
jest.mock('../../config.js', () => ({ config: mockConfig }));

const execMock = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...args: unknown[]) => execMock(...args) }));

import { getWorkItem, resetAppUsersProbe, resetBriefColumnsProbe, resetRunbookPinsProbe, setWorkItemRunbookPins } from '../work-items.js';
import { fixtureRegistry } from '../../mock/core/index.js';

describe('runbook pins — mock path', () => {
  beforeAll(() => { mockConfig.mock.aurora = true; });
  beforeEach(() => fixtureRegistry.resetAll());

  it('every item starts with none; a write replaces them in order; a reset takes them back', async () => {
    expect((await getWorkItem('wi-auth-e2-s2'))!.runbookPins).toEqual([]);
    expect(await setWorkItemRunbookPins('wi-auth-e2-s2', ['rb-sso-new-origin', 'rb-tenant-cutover'])).toEqual({ kind: 'ok', runbookPins: ['rb-sso-new-origin', 'rb-tenant-cutover'] });
    expect((await getWorkItem('wi-auth-e2-s2'))!.runbookPins).toEqual(['rb-sso-new-origin', 'rb-tenant-cutover']);
    expect(await setWorkItemRunbookPins('wi-auth-e2-s2', [])).toEqual({ kind: 'ok', runbookPins: [] });
    await setWorkItemRunbookPins('wi-auth-e2-s2', ['rb-tenant-cutover']);
    fixtureRegistry.resetAll();
    expect((await getWorkItem('wi-auth-e2-s2'))!.runbookPins).toEqual([]);
  });

  it('an unknown item is not-found', async () => {
    expect(await setWorkItemRunbookPins('wi-nope', ['rb-tenant-cutover'])).toEqual({ kind: 'not-found' });
  });
});

describe('runbook pins — Aurora path', () => {
  beforeAll(() => { mockConfig.mock.aurora = false; });
  afterAll(() => { mockConfig.mock.aurora = true; });
  beforeEach(() => {
    execMock.mockReset();
    resetBriefColumnsProbe();
    resetAppUsersProbe();
    resetRunbookPinsProbe();
  });

  const itemRow = { id: 'wi-1', project_id: 'p-1', project_name: 'Pilot', type: 'story', title: 'Ship it', status: 'open', priority: 'high' };

  /** Route exec by what the SQL asks: the probes, the read, the write. */
  function aurora(opts: { pinsColumn: boolean; stored?: unknown; updated?: unknown[] }) {
    execMock.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.tables')) return [{ ok: 1 }];
      if (sql.includes("column_name = 'runbook_pins'")) return opts.pinsColumn ? [{ column_name: 'runbook_pins' }] : [];
      if (sql.includes('information_schema.columns')) return [];
      if (sql.startsWith('\n    SELECT') || sql.trimStart().startsWith('SELECT')) return [{ ...itemRow, runbook_pins: opts.stored ?? null }];
      if (sql.includes('UPDATE work_items SET runbook_pins')) return opts.updated ?? [];
      return [];
    });
  }

  it('reads the column through to_jsonb: JSON text, an array, or null (no column) all read cleanly', async () => {
    aurora({ pinsColumn: true, stored: '["rb-a1","rb-b2"]' });
    expect((await getWorkItem('wi-1'))!.runbookPins).toEqual(['rb-a1', 'rb-b2']);
    const sql = String(execMock.mock.calls.find(([s]) => String(s).includes('FROM work_items wi'))![0]);
    expect(sql).toContain("to_jsonb(wi)->'runbook_pins' AS runbook_pins");
    aurora({ pinsColumn: true, stored: ['rb-a1'] });
    expect((await getWorkItem('wi-1'))!.runbookPins).toEqual(['rb-a1']);
    aurora({ pinsColumn: false, stored: null });
    expect((await getWorkItem('wi-1'))!.runbookPins).toEqual([]);
    aurora({ pinsColumn: true, stored: 'not json' });
    expect((await getWorkItem('wi-1'))!.runbookPins).toEqual([]);
  });

  it('writes the ordered list as a TEXT[] literal, by id, and returns what was stored', async () => {
    aurora({ pinsColumn: true, updated: [{ runbook_pins: '["rb-sso-new-origin","rb-tenant-cutover"]' }] });
    expect(await setWorkItemRunbookPins('wi-1', ['rb-sso-new-origin', 'rb-tenant-cutover'])).toEqual({ kind: 'ok', runbookPins: ['rb-sso-new-origin', 'rb-tenant-cutover'] });
    const [sql, params] = execMock.mock.calls.find(([s]) => String(s).includes('UPDATE work_items SET runbook_pins'))!;
    expect(sql).toContain("runbook_pins = ARRAY['rb-sso-new-origin','rb-tenant-cutover']");
    expect(sql).toContain('WHERE id = :id');
    expect(params).toEqual([{ name: 'id', value: { stringValue: 'wi-1' } }]);
  });

  it('clears with an empty array; a missing row is not-found; a cluster without the column is unavailable, never an error', async () => {
    aurora({ pinsColumn: true, updated: [{ runbook_pins: '[]' }] });
    expect(await setWorkItemRunbookPins('wi-1', [])).toEqual({ kind: 'ok', runbookPins: [] });
    expect(String(execMock.mock.calls.find(([s]) => String(s).includes('UPDATE'))![0])).toContain('runbook_pins = ARRAY[]::TEXT[]');
    aurora({ pinsColumn: true, updated: [] });
    expect(await setWorkItemRunbookPins('wi-nope', ['rb-a1'])).toEqual({ kind: 'not-found' });
    resetRunbookPinsProbe();
    execMock.mockClear();
    aurora({ pinsColumn: false });
    expect(await setWorkItemRunbookPins('wi-1', ['rb-a1'])).toEqual({ kind: 'unavailable', error: expect.stringMatching(/runbook_pins/) });
    expect(execMock.mock.calls.some(([s]) => String(s).includes('UPDATE'))).toBe(false);
  });
});
