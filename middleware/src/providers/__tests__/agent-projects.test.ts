// Read-path fan-out for the agent-projects list.
//
// The list surface is polled and shows the latest runs for every linked repo.
// Fetching them a project at a time cost one RDS Data API round-trip per
// repository (an N+1 that grew with the fleet); listRecentRunsForProjects folds
// that into a SINGLE window-function query and groups in memory. The DB layer is
// stubbed — what matters is the call count (1, not N) and the grouping.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { listRecentRunsForProjects } from '../agent-projects.js';

const execMock = exec as unknown as jest.Mock;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function runRow(id: string, projectId: string, startedAt: string): Record<string, unknown> {
  return {
    id, project_id: projectId, prompt: 'do the thing', model: 'nova',
    status: 'done', started_at: startedAt, finished_at: startedAt,
    duration_ms: 1200, files_changed: 3, diff_summary: '+3', error: null, cost_usd: 0.01,
  };
}

beforeEach(() => execMock.mockReset());

describe('listRecentRunsForProjects', () => {
  it('issues exactly ONE query for N projects (kills the N+1)', async () => {
    execMock.mockResolvedValue([]);
    await listRecentRunsForProjects([A, B, C], 5);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('groups runs by project id, preserving per-project started_at DESC order', async () => {
    // Rows arrive ordered by (project_id, started_at DESC) — the query's ORDER BY.
    execMock.mockResolvedValue([
      runRow('a2', A, '2026-08-20T02:00:00Z'),
      runRow('a1', A, '2026-08-20T01:00:00Z'),
      runRow('b1', B, '2026-08-20T05:00:00Z'),
    ]);
    const grouped = await listRecentRunsForProjects([A, B, C]);

    expect([...grouped.keys()].sort()).toEqual([A, B].sort());
    expect(grouped.get(A)?.map((r) => r.id)).toEqual(['a2', 'a1']);
    expect(grouped.get(B)?.map((r) => r.id)).toEqual(['b1']);
    // A project with no runs is simply absent from the map (route defaults to []).
    expect(grouped.get(C)).toBeUndefined();
    // Rows are mapped through rowToRun, not passed raw.
    expect(grouped.get(A)?.[0]).toMatchObject({ projectId: A, status: 'done', filesChanged: 3, costUsd: 0.01 });
  });

  it('binds one parameter per id and selects only rowToRun columns (no SELECT *)', async () => {
    execMock.mockResolvedValue([]);
    await listRecentRunsForProjects([A, B], 5);
    const [sql, params] = execMock.mock.calls[0] as [string, unknown[]];

    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY project_id ORDER BY started_at DESC\)/);
    expect(sql).toContain(':p0::uuid');
    expect(sql).toContain(':p1::uuid');
    expect(sql).not.toContain('SELECT *');
    expect(sql).toMatch(/rn <= 5/);
    expect(params).toHaveLength(2);
  });

  it('clamps perProject into [1, 100]', async () => {
    execMock.mockResolvedValue([]);
    await listRecentRunsForProjects([A], 999);
    expect(execMock.mock.calls[0][0]).toMatch(/rn <= 100/);
  });

  it('never touches the DB when there are no valid uuid ids', async () => {
    execMock.mockResolvedValue([]);
    const grouped = await listRecentRunsForProjects(['not-a-uuid', '']);
    expect(execMock).not.toHaveBeenCalled();
    expect(grouped.size).toBe(0);
  });
});
