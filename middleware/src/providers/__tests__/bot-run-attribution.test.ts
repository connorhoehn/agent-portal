// bot_runs.dispatched_by — the attribution the sprint-envelope brake burns
// down against, and the schema tolerance that lets the middleware ship ahead of
// schema/agent_run_attribution_schema.sql.
//
// The failure mode being designed out: a missing column reported as a burn of
// $0. Zero is headroom a budget brake will happily spend; "unknown" is not. So
// every path here answers with the pair (spend, attributionAvailable) and never
// with a bare number.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import {
  attributionAvailable, resetAttributionProbe, dispatchedSpendInWindow, createBotRun,
} from '../bots.js';

const sql = exec as unknown as jest.Mock;

/** The last statement sent, whitespace-flattened for readable matching. */
function lastSql(): string {
  return String(sql.mock.calls.at(-1)?.[0] ?? '').replace(/\s+/g, ' ');
}
function lastParams(): Array<{ name: string; value: Record<string, unknown> }> {
  return (sql.mock.calls.at(-1)?.[1] ?? []) as Array<{ name: string; value: Record<string, unknown> }>;
}
const paramNames = (): string[] => lastParams().map((p) => p.name);

beforeEach(() => {
  sql.mockReset();
  resetAttributionProbe();
});

describe('attributionAvailable', () => {
  it('asks information_schema, not a failed INSERT', async () => {
    sql.mockResolvedValue([{ ok: 1 }]);
    expect(await attributionAvailable()).toBe(true);
    expect(lastSql()).toContain('information_schema.columns');
    expect(lastSql()).toContain("column_name = 'dispatched_by'");
  });

  it('answers false when the column is not there', async () => {
    sql.mockResolvedValue([]);
    expect(await attributionAvailable()).toBe(false);
  });

  it('answers false rather than throwing when the probe itself fails', async () => {
    sql.mockRejectedValue(new Error('connection reset'));
    expect(await attributionAvailable()).toBe(false);
  });

  it('probes once per process — this runs on every dispatch', async () => {
    sql.mockResolvedValue([{ ok: 1 }]);
    await attributionAvailable();
    await attributionAvailable();
    await attributionAvailable();
    expect(sql).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchedSpendInWindow', () => {
  const input = {
    orgProjectId: 'p-observability', dispatchedBy: 'u-layla',
    startsOn: '2026-08-10', endsOn: '2026-08-24',
  };

  it('reports an UNKNOWN burn, not a zero one, when the column is absent', async () => {
    sql.mockResolvedValue([]); // the probe finds nothing
    expect(await dispatchedSpendInWindow(input)).toEqual({
      spentUsd: 0, attributionAvailable: false,
    });
    // And it did not even try to sum — there is nothing to sum by.
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('sums only the runs recorded as dispatched by this subject', async () => {
    sql.mockResolvedValueOnce([{ ok: 1 }]).mockResolvedValueOnce([{ spent: 12.5 }]);
    expect(await dispatchedSpendInWindow(input)).toEqual({
      spentUsd: 12.5, attributionAvailable: true,
    });
    expect(lastSql()).toContain('br.dispatched_by = :by');
    // The initiative predicate is the ledger's own, imported not re-derived.
    expect(lastSql()).toContain('br.work_item_id IN');
    expect(paramNames().sort()).toEqual(['by', 'from', 'pid', 'to']);
  });

  it('leaves an open side of the window unbounded (a standing grant)', async () => {
    sql.mockResolvedValueOnce([{ ok: 1 }]).mockResolvedValueOnce([{ spent: 3 }]);
    await dispatchedSpendInWindow({ ...input, startsOn: null, endsOn: null });
    expect(lastSql()).not.toContain('started_at >=');
    expect(paramNames().sort()).toEqual(['by', 'pid']);
  });

  it('treats the sprint end date as inclusive', async () => {
    sql.mockResolvedValueOnce([{ ok: 1 }]).mockResolvedValueOnce([{ spent: 0 }]);
    await dispatchedSpendInWindow(input);
    expect(lastSql()).toContain("br.started_at < :to::date + 1");
  });

  it('degrades to unknown when the column vanishes under it, and re-probes', async () => {
    sql
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockRejectedValueOnce(new Error('column "dispatched_by" does not exist'))
      .mockResolvedValueOnce([]);
    expect(await dispatchedSpendInWindow(input)).toEqual({
      spentUsd: 0, attributionAvailable: false,
    });
    // The cached "yes" was dropped, so the next call re-asks instead of
    // failing forever on a stale probe.
    expect(await dispatchedSpendInWindow(input)).toEqual({
      spentUsd: 0, attributionAvailable: false,
    });
    expect(lastSql()).toContain('information_schema.columns');
  });

  it('re-raises a real database failure — it is not a schema question', async () => {
    sql.mockResolvedValueOnce([{ ok: 1 }]).mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(dispatchedSpendInWindow(input)).rejects.toThrow(/deadlock/);
  });
});

describe('createBotRun writes attribution only when it can', () => {
  it('records the dispatcher when the column exists', async () => {
    sql.mockResolvedValueOnce([{ ok: 1 }]).mockResolvedValueOnce([{ id: 'r1', status: 'running' }]);
    const run = await createBotRun({
      botId: null, trigger: 'marketplace', runId: '11111111-2222-3333-4444-555555555555',
      workItemId: 'wi-1', ceiling: 3, dispatchedBy: 'u-layla',
    });
    expect(lastSql()).toContain('dispatched_by');
    expect(paramNames()).toContain('by');
    expect(run?.dispatchedBy).toBeNull(); // the stub row carries no column back
  });

  it('drops it silently on a cluster without the migration', async () => {
    sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r1', status: 'running' }]);
    await createBotRun({
      botId: null, trigger: 'marketplace', ceiling: 3, dispatchedBy: 'u-layla',
    });
    // A run that cannot be attributed is still a run worth recording.
    expect(lastSql()).not.toContain('dispatched_by');
    expect(paramNames()).not.toContain('by');
  });

  it('does not probe at all for a firing nobody authorized (cron)', async () => {
    sql.mockResolvedValueOnce([{ id: 'r1', status: 'running' }]);
    await createBotRun({ botId: 'b1', trigger: 'cron', ceiling: 3, dispatchedBy: null });
    expect(sql).toHaveBeenCalledTimes(1);
    expect(lastSql()).not.toContain('dispatched_by');
  });

  it('reads the column back onto the run when the row carries it', async () => {
    sql.mockResolvedValueOnce([{ ok: 1 }]).mockResolvedValueOnce([
      { id: 'r1', status: 'running', dispatched_by: 'u-layla' },
    ]);
    const run = await createBotRun({
      botId: null, trigger: 'marketplace', ceiling: 3, dispatchedBy: 'u-layla',
    });
    expect(run?.dispatchedBy).toBe('u-layla');
  });
});
