// providers/distillation-store.ts — the Aurora read path for the distillation
// ops tables (schema/distillation_ops_schema.sql), and its agreement with the
// write-side mirror.
//
// What is pinned:
//   * SQL shape: explicit column lists, parameterized filters, the columns the
//     reads select are exactly the columns persistJob writes.
//   * Row mapping to the SAME wire type the mock path serves, including the
//     Data API's naive TIMESTAMPTZ strings read as UTC (the devbox-fleet trap:
//     `new Date('2026-09-24 12:00:00')` is LOCAL time).
//   * JSON text columns (input_ids / output_ids / log) parsed.
//   * A failed read is a 503 AppError — never an empty list or a zero.
//   * The provider routes through this path when config.mock.aurora is off.

const exec = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...a: unknown[]) => exec(...a) }));
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: false },
    auth: {},
    messageQueue: { mock: true },
    aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
  },
}));

import { AppError } from '../../lib/async-handler.js';
import {
  readCompactions, readCompaction, readRecentWriters, rowToCompactionJob, persistJob,
  COMPACTION_LIST_LIMIT, type PersistableJob,
} from '../distillation-store.js';
import { listCompactions, getCompaction, ingest, levelsView } from '../distillation.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function storedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'comp-abc-1',
    level: 'L1',
    repo: 'orgiq/auth-service',
    status: 'succeeded',
    phase: 'done',
    percent: 100,
    requested_by: 'Priya',
    // Naive, exactly as the RDS Data API returns TIMESTAMPTZ.
    queued_at: '2026-09-24 10:00:00',
    started_at: '2026-09-24 10:00:05.250',
    finished_at: '2026-09-24 10:01:05.250',
    input_ids: '["obs-001","obs-002","obs-003"]',
    output_ids: '["cl-101"]',
    log: '[{"at":"2026-09-24T10:00:05.250Z","level":"info","message":"Claimed 3 run notes."}]',
    what_changed: 'Merged 3 run notes into 1 pattern, folding 2 duplicates.',
    duration_ms: 60000,
    cost_usd: '0.0009',
    error: null,
    attempts: 1,
    step_label: null,
    bytes_reclaimed: 2048,
    ...over,
  };
}

const oneLine = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const colsOf = (list: string): string[] =>
  list.split(',').map((c) => c.trim().split(/\s+AS\s+/i).pop()!.trim()).filter(Boolean);

beforeEach(() => exec.mockReset());

describe('readCompactions — SQL shape', () => {
  it('selects an explicit column list, newest first, bounded', async () => {
    exec.mockResolvedValueOnce([]);
    await readCompactions({}, NOW);
    const [sql, params] = exec.mock.calls[0]!;
    const flat = oneLine(sql);
    expect(flat).not.toMatch(/SELECT \*/);
    expect(flat).toMatch(/FROM distillation_compactions/);
    expect(flat).not.toMatch(/WHERE/);
    expect(flat).toMatch(/ORDER BY COALESCE\(started_at, queued_at\) DESC, id DESC LIMIT :limit/);
    expect(flat).toMatch(/to_json\(input_ids\)::text AS input_ids/);
    expect(flat).toMatch(/log::text AS log/);
    expect(params).toEqual([{ name: 'limit', value: { longValue: COMPACTION_LIST_LIMIT } }]);
  });

  it('filters are bound parameters, never interpolated', async () => {
    exec.mockResolvedValueOnce([]);
    await readCompactions({ level: 'L2', status: 'failed' }, NOW);
    const [sql, params] = exec.mock.calls[0]!;
    expect(oneLine(sql)).toMatch(/WHERE level = :level AND status = :status/);
    expect(sql).not.toContain("'L2'");
    expect(params).toEqual(expect.arrayContaining([
      { name: 'level', value: { stringValue: 'L2' } },
      { name: 'status', value: { stringValue: 'failed' } },
    ]));
  });

  it('readCompaction binds the id', async () => {
    exec.mockResolvedValueOnce([]);
    expect(await readCompaction('comp-abc-1', NOW)).toBeNull();
    const [sql, params] = exec.mock.calls[0]!;
    expect(oneLine(sql)).toMatch(/FROM distillation_compactions WHERE id = :id$/);
    expect(params).toEqual([{ name: 'id', value: { stringValue: 'comp-abc-1' } }]);
  });
});

describe('write path and read path agree on columns', () => {
  it('every column persistJob writes is a column the read selects, and vice versa', async () => {
    exec.mockResolvedValue([]);
    const job: PersistableJob = {
      id: 'comp-x', level: 'L1', repo: null, status: 'running', phase: 'merge', percent: 50,
      requested_by: 'p', queued_at: '2026-09-24T10:00:00.000Z', startedAt: '2026-09-24T10:00:01.000Z',
      finishedAt: null, input_ids: ['obs-1'], output_ids: [], log: [], what_changed: 'x',
      duration_ms: 1000, cost_usd: 0.0003, attempts: 1, stepLabel: 'Merging', bytesReclaimed: 0,
    };
    persistJob(job);
    await readCompactions({}, NOW);
    const writeSql = oneLine(exec.mock.calls[0]![0]);
    const written = colsOf(writeSql.match(/INSERT INTO distillation_compactions \(([^)]*)\)/)![1]!);
    const readSql = oneLine(exec.mock.calls[1]![0]);
    const read = colsOf(readSql.match(/^SELECT (.*) FROM distillation_compactions/)![1]!);
    expect([...read].sort()).toEqual([...written].sort());
    // and the running pass's step label reaches the mirror
    expect(exec.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      { name: 'step_label', value: { stringValue: 'Merging' } },
    ]));
  });
});

describe('rowToCompactionJob — mapping', () => {
  it('reads naive TIMESTAMPTZ as UTC and parses the JSON columns', () => {
    const job = rowToCompactionJob(storedRow(), NOW);
    expect(job.queued_at).toBe('2026-09-24T10:00:00.000Z');
    expect(job.startedAt).toBe('2026-09-24T10:00:05.250Z');
    expect(job.finishedAt).toBe('2026-09-24T10:01:05.250Z');
    expect(job.input_ids).toEqual(['obs-001', 'obs-002', 'obs-003']);
    expect(job.output_ids).toEqual(['cl-101']);
    expect(job.log).toEqual([{ at: '2026-09-24T10:00:05.250Z', level: 'info', message: 'Claimed 3 run notes.' }]);
  });

  it('counts from the stored ids and reads the rest through', () => {
    const job = JSON.parse(JSON.stringify(rowToCompactionJob(storedRow(), NOW)));
    expect(job).toMatchObject({
      id: 'comp-abc-1', level: 'L1', status: 'succeeded', inputItems: 3, outputItems: 1, dedupedItems: 2,
      bytesReclaimed: 2048, costUsd: 0.0009, cost_usd: 0.0009, produced: { cluster_ids: ['cl-101'], artifact_ids: [] },
      queue: 'distill-compact-l1', repo: 'orgiq/auth-service', requested_by: 'Priya', duration_ms: 60000,
      phase: 'done', percent: 100, stepLabel: null, attempts: 1,
    });
    expect(job).not.toHaveProperty('error');
  });

  it('keeps a zoned timestamp as the instant it names', () => {
    const job = rowToCompactionJob(storedRow({ queued_at: '2026-09-24T06:00:00-04:00' }), NOW);
    expect(job.queued_at).toBe('2026-09-24T10:00:00.000Z');
  });

  it('a queued row starts when it was queued and has no duration', () => {
    const job = rowToCompactionJob(storedRow({
      status: 'queued', phase: 'queued', percent: 0, started_at: null, finished_at: null,
      input_ids: '[]', output_ids: '[]', duration_ms: null, bytes_reclaimed: null,
    }), NOW);
    expect(job.startedAt).toBe('2026-09-24T10:00:00.000Z');
    expect(job.duration_ms).toBeNull();
    expect(job.bytesReclaimed).toBe(0);
  });

  it('a running row counts its duration so far', () => {
    const job = rowToCompactionJob(storedRow({ status: 'running', finished_at: null, duration_ms: 5 }), NOW);
    expect(job.duration_ms).toBe(NOW - Date.parse('2026-09-24T10:00:05.250Z'));
  });

  it('an L2 pass produced artifacts; a failed one deduped nothing and carries its error', () => {
    const job = rowToCompactionJob(storedRow({
      level: 'L2', status: 'failed', phase: 'failed', output_ids: '[]', error: 'write failed',
    }), NOW);
    expect(job.produced).toEqual({ cluster_ids: [], artifact_ids: [] });
    expect(job.queue).toBe('distill-compact-l2');
    expect(job.dedupedItems).toBe(0);
    expect(job.error).toBe('write failed');
  });

  it('an unrecorded bytes_reclaimed is unknown (null), not zero', () => {
    expect(rowToCompactionJob(storedRow({ bytes_reclaimed: null }), NOW).bytesReclaimed).toBeNull();
  });

  it('refuses a row it cannot read rather than inventing values', () => {
    expect(() => rowToCompactionJob(storedRow({ log: '{"not":"an array"}' }), NOW)).toThrow(/log/);
    expect(() => rowToCompactionJob(storedRow({ input_ids: 'nope' }), NOW)).toThrow();
    expect(() => rowToCompactionJob(storedRow({ queued_at: null }), NOW)).toThrow(/queued_at/);
    expect(() => rowToCompactionJob(storedRow({ started_at: 'yesterday' }), NOW)).toThrow(/started_at/);
  });
});

describe('failed reads are surfaced, not swallowed', () => {
  it('a Data API failure on the job list is a 503', async () => {
    exec.mockRejectedValueOnce(new Error('HttpEndpointNotEnabledException'));
    const p = readCompactions({}, NOW);
    await expect(p).rejects.toBeInstanceOf(AppError);
    await expect(p).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/HttpEndpointNotEnabled/) });
  });

  it('an unreadable row is a 503 too, not a shorter list', async () => {
    exec.mockResolvedValueOnce([storedRow(), storedRow({ id: 'comp-bad', log: 'garbage' })]);
    await expect(readCompactions({}, NOW)).rejects.toMatchObject({ status: 503 });
  });

  it('a failed writer read is a 503', async () => {
    exec.mockRejectedValueOnce(new Error('relation "distillation_ingest_writers" does not exist'));
    await expect(readRecentWriters(3_600_000)).rejects.toMatchObject({ status: 503 });
  });
});

describe('readRecentWriters', () => {
  it('windows on last_write_at with a bound parameter and maps naive timestamps', async () => {
    exec.mockResolvedValueOnce([{
      id: 'w-1', session_id: 's-1', box_id: null, repo: 'orgiq/auth-service', initiative_id: 'p-auth-migration',
      observations_per_hour: '12.50', last_write_at: '2026-09-24 11:59:00',
    }]);
    const rows = await readRecentWriters(3_600_000);
    const [sql, params] = exec.mock.calls[0]!;
    expect(oneLine(sql)).toMatch(
      /^SELECT id, session_id, box_id, repo, initiative_id, observations_per_hour, last_write_at FROM distillation_ingest_writers WHERE last_write_at >= NOW\(\) - make_interval\(secs => :window_s\)/,
    );
    expect(params).toEqual([{ name: 'window_s', value: { longValue: 3600 } }]);
    expect(rows).toEqual([{
      id: 'w-1', session_id: 's-1', box_id: null, repo: 'orgiq/auth-service', initiative_id: 'p-auth-migration',
      observationsPerHour: 12.5, last_write_at: '2026-09-24T11:59:00.000Z',
    }]);
  });
});

describe('provider — Aurora branch (config.mock.aurora off)', () => {
  it('listCompactions and getCompaction read the table', async () => {
    exec.mockResolvedValueOnce([storedRow()]);
    const jobs = await listCompactions({ level: 'L1' });
    expect(jobs.map((j) => j.id)).toEqual(['comp-abc-1']);
    exec.mockResolvedValueOnce([]);
    expect(await getCompaction('comp-missing')).toBeNull();
    expect(oneLine(exec.mock.calls[1]![0])).toMatch(/WHERE id = :id/);
  });

  it('ingest counts from the windowed writer rows', async () => {
    const writers = [
      { id: 'w-1', session_id: 's-1', box_id: 'b', repo: 'a/one', initiative_id: null, observations_per_hour: '30', last_write_at: '2026-09-24 11:59:00' },
      { id: 'w-2', session_id: 's-2', box_id: 'b', repo: 'a/two', initiative_id: null, observations_per_hour: '10', last_write_at: '2026-09-24 11:58:00' },
    ];
    // simulateIngest may fire a fire-and-forget mirror write too; only the
    // SELECT answers with rows.
    exec.mockImplementation(async (sql: string) => (/^\s*SELECT/.test(sql) && sql.includes('distillation_ingest_writers') ? writers : []));
    const state = await ingest();
    expect(state).toEqual({
      activeWriters: 2,
      observationsPerHour: 40,
      topRepos: [{ repo: 'a/one', share: 0.75 }, { repo: 'a/two', share: 0.25 }],
    });
  });

  it('ingest surfaces a failed read instead of reporting zero writers', async () => {
    exec.mockRejectedValue(new Error('cluster paused'));
    await expect(ingest()).rejects.toMatchObject({ status: 503 });
  });

  it('levelsView surfaces a failed read instead of a zero writer count', async () => {
    exec.mockRejectedValue(new Error('cluster paused'));
    await expect(levelsView()).rejects.toMatchObject({ status: 503 });
  });
});
