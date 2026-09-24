// Durable mirror of distillation's operational rows
// (schema/distillation_ops_schema.sql): compaction job records and the L0
// write-stream's writers — and, with Aurora configured, the read path for them.
//
// Scope, stated plainly: the distillation CORPUS is still mock-first
// (providers/distillation.ts's module note) — observations, clusters and
// artifacts are fixture rows, so a job's produced ids point into those. The
// write half records what the queue consumer did (every transition upserts the
// job, in the same shape `GET /compactions` serves) and who has been writing
// L0. The read half (readCompactions / readCompaction / readRecentWriters)
// serves those rows back when `config.mock.aurora` is off; the provider
// decides which path runs, and the mock path never reaches this half.
//
// Two degradation contracts, on purpose different:
//   * WRITES are fire-and-forget: Aurora mocked, unconfigured or down leaves
//     compaction working exactly as before, and nothing throws back into the
//     consumer (same as providers/devbox-fleet-store.ts).
//   * READS fail loud: a failed query or an unreadable row is a 503, never an
//     empty list or a zero — "the table is unreachable" and "nothing has run"
//     must not be spelled the same way on the wire.
//
// Column agreement: every column persistJob writes is a column the reads
// select, and vice versa — the column lists below are the contract, and
// distillation-store.test.ts pins both.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { AppError } from '../lib/async-handler.js';
import { utcIso } from '../lib/devbox-fleet-rows.js';
import { COMPACTION_QUEUES } from '../lib/distillation-queue.js';
import type {
  CompactionStatus, CompactionPhase, CompactionLogEntry, Level,
} from '../mock/distillation.js';
// Type-only, so the provider ↔ store cycle has no runtime edge.
import type { CompactionJob } from './distillation.js';

function usable(): boolean {
  // A raw exec() reaches the RDS Data API whatever config.mock.aurora says, so
  // the mock flag is checked here rather than relied on downstream.
  const aurora = (config as { aurora?: { clusterArn?: string; secretArn?: string } }).aurora;
  return !config.mock.aurora && Boolean(aurora?.clusterArn && aurora?.secretArn);
}

const str = (name: string, value: string | null | undefined): SqlParameter =>
  value == null || value === ''
    ? { name, value: { isNull: true } }
    : { name, value: { stringValue: value } };

const num = (name: string, value: number | null | undefined): SqlParameter =>
  value == null || !Number.isFinite(value)
    ? { name, value: { isNull: true } }
    : { name, value: { doubleValue: value } };

/** The job fields the table stores — the wire job's own names. */
export interface PersistableJob {
  id: string;
  level: string;
  repo: string | null;
  status: string;
  phase: string;
  percent: number | null;
  requested_by: string | null;
  queued_at: string;
  startedAt: string;
  finishedAt: string | null;
  input_ids: string[];
  output_ids: string[];
  log: unknown[];
  what_changed: string;
  duration_ms: number | null;
  cost_usd: number;
  error?: string;
  attempts: number;
  stepLabel: string | null;
  bytesReclaimed: number | null;
}

let warned = false;
function warnOnce(err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn('[distill-store] Aurora mirror unavailable, continuing in memory:', (err as Error).message);
}

/** Upsert one job as it stands now. Never throws. */
export function persistJob(job: PersistableJob): void {
  if (!usable()) return;
  const started = job.status === 'queued' ? null : job.startedAt;
  void exec(
    `INSERT INTO distillation_compactions
       (id, level, repo, status, phase, percent, requested_by, queued_at, started_at, finished_at,
        input_ids, output_ids, log, what_changed, duration_ms, cost_usd, error, attempts,
        step_label, bytes_reclaimed)
     VALUES (:id, :level, :repo, :status, :phase, :percent, :requested_by, :queued_at::timestamptz,
        :started_at::timestamptz, :finished_at::timestamptz,
        ARRAY(SELECT jsonb_array_elements_text(:input_ids::jsonb)),
        ARRAY(SELECT jsonb_array_elements_text(:output_ids::jsonb)),
        :log::jsonb, :what_changed, :duration_ms, :cost_usd, :error, :attempts,
        :step_label, :bytes_reclaimed)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status, phase = EXCLUDED.phase, percent = EXCLUDED.percent,
       started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
       input_ids = EXCLUDED.input_ids, output_ids = EXCLUDED.output_ids, log = EXCLUDED.log,
       what_changed = EXCLUDED.what_changed, duration_ms = EXCLUDED.duration_ms,
       cost_usd = EXCLUDED.cost_usd, error = EXCLUDED.error, attempts = EXCLUDED.attempts,
       step_label = EXCLUDED.step_label, bytes_reclaimed = EXCLUDED.bytes_reclaimed`,
    [
      str('id', job.id), str('level', job.level), str('repo', job.repo), str('status', job.status),
      str('phase', job.phase), num('percent', job.percent), str('requested_by', job.requested_by),
      str('queued_at', job.queued_at), str('started_at', started), str('finished_at', job.finishedAt),
      str('input_ids', JSON.stringify(job.input_ids)), str('output_ids', JSON.stringify(job.output_ids)),
      str('log', JSON.stringify(job.log)), str('what_changed', job.what_changed),
      num('duration_ms', job.duration_ms), num('cost_usd', job.cost_usd), str('error', job.error ?? null),
      num('attempts', job.attempts), str('step_label', job.stepLabel),
      num('bytes_reclaimed', job.bytesReclaimed),
    ],
  ).catch(warnOnce);
}

export interface PersistableWriter {
  id: string;
  session_id: string;
  box_id: string;
  repo: string;
  initiative_id: string;
  observationsPerHour: number;
}

/** Record that a writer just landed an L0 row. Never throws. */
export function recordWriterWrite(writer: PersistableWriter, at: string): void {
  if (!usable()) return;
  void exec(
    `INSERT INTO distillation_ingest_writers
       (id, session_id, box_id, repo, initiative_id, observations_per_hour, last_write_at, updated_at)
     VALUES (:id, :session_id, :box_id, :repo, :initiative_id, :rate, :at::timestamptz, NOW())
     ON CONFLICT (id) DO UPDATE SET
       session_id = EXCLUDED.session_id, box_id = EXCLUDED.box_id, repo = EXCLUDED.repo,
       initiative_id = EXCLUDED.initiative_id, observations_per_hour = EXCLUDED.observations_per_hour,
       last_write_at = GREATEST(distillation_ingest_writers.last_write_at, EXCLUDED.last_write_at),
       updated_at = NOW()`,
    [
      str('id', writer.id), str('session_id', writer.session_id), str('box_id', writer.box_id),
      str('repo', writer.repo), str('initiative_id', writer.initiative_id),
      num('rate', writer.observationsPerHour), str('at', at),
    ],
  ).catch(warnOnce);
}

// ─── Read path (Aurora configured, config.mock.aurora off) ──────────────────
//
// The provider calls these only on its non-mock branch. Each maps a stored row
// to the SAME wire type the mock path serves. What the table stores is read
// through; what is countable from stored ids (inputItems, outputItems,
// dedupedItems, produced) is counted from them; nothing is invented.

/** Rows a list read returns at most, newest first. The table only grows; an
 *  older job is still reachable by id through readCompaction. */
export const COMPACTION_LIST_LIMIT = 500;

/** The column list both reads select — the same columns persistJob writes.
 *  Arrays and JSONB come back as JSON text, parsed below: the Data API's
 *  array support is uneven, and text is one decoding path for both. */
const COMPACTION_COLUMNS = `id, level, repo, status, phase, percent, requested_by,
       queued_at, started_at, finished_at,
       to_json(input_ids)::text AS input_ids, to_json(output_ids)::text AS output_ids,
       log::text AS log, what_changed, duration_ms, cost_usd, error, attempts,
       step_label, bytes_reclaimed`;

/** A read that could not answer. 503, and the message names the table, so
 *  the route's error body says what is unavailable rather than "0 jobs". */
function unavailable(table: string, err: unknown): AppError {
  return new AppError(503, `Distillation ${table} unavailable: ${(err as Error).message}`);
}

/** A nullable TIMESTAMPTZ. The Data API returns it NAIVE ("2026-09-24
 *  12:00:00.123", UTC with no zone); utcIso reads it as UTC. null stays null,
 *  and an unparseable value throws — utcIso's own fallback is "now", which for
 *  a missing or garbled time would be a lie. */
function isoOrNull(raw: unknown, col: string): string | null {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const probe = `${text.includes('T') ? text : text.replace(' ', 'T')}${zoned ? '' : 'Z'}`;
  if (!Number.isFinite(Date.parse(probe))) throw new Error(`${col} is not a timestamp: ${JSON.stringify(raw)}`);
  return utcIso(text);
}

/** A timestamp the row cannot be read without. */
function isoRequired(raw: unknown, col: string): string {
  const iso = isoOrNull(raw, col);
  if (!iso) throw new Error(`${col} is missing`);
  return iso;
}

function numOrNull(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function jsonArray<T>(raw: unknown, col: string): T[] {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new Error(`${col} is not a JSON array`);
  return parsed as T[];
}

/** One stored row → the wire job. Throws on a row it cannot read honestly. */
export function rowToCompactionJob(r: Record<string, unknown>, nowMs: number): CompactionJob {
  const id = String(r['id'] ?? '');
  const level = String(r['level']) as Level;
  const status = String(r['status']) as CompactionStatus;
  const queuedAt = isoRequired(r['queued_at'], 'queued_at');
  const startedRaw = isoOrNull(r['started_at'], 'started_at');
  const finishedAt = isoOrNull(r['finished_at'], 'finished_at');
  const inputIds = jsonArray<string>(r['input_ids'], 'input_ids').map(String);
  const outputIds = jsonArray<string>(r['output_ids'], 'output_ids').map(String);
  const log = jsonArray<CompactionLogEntry>(r['log'], 'log');
  const costUsd = numOrNull(r['cost_usd']) ?? 0;
  const storedDuration = numOrNull(r['duration_ms']);
  const bytes = numOrNull(r['bytes_reclaimed']);
  const error = r['error'] == null || r['error'] === '' ? undefined : String(r['error']);
  // A queued row has no started_at; its startedAt is when it was queued, the
  // same as the in-memory row compactNow builds.
  const startedAt = startedRaw ?? queuedAt;
  // A running pass's duration is "so far" — counted from its start, as the
  // mock path counts it. A finished one is its stored record.
  const durationMs = status === 'queued'
    ? null
    : status === 'running'
      ? Math.max(0, nowMs - Date.parse(startedAt))
      : storedDuration ?? (finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null);
  const succeeded = status === 'succeeded';
  return {
    id,
    level,
    startedAt,
    finishedAt,
    status,
    inputItems: inputIds.length,
    outputItems: outputIds.length,
    dedupedItems: succeeded ? Math.max(0, inputIds.length - outputIds.length) : 0,
    // Not countable from the ids — the corpus rows they name are not in
    // Aurora. The value recorded when the pass finished, or null (unknown).
    bytesReclaimed: succeeded ? bytes : 0,
    costUsd,
    ...(error ? { error } : {}),
    // An L1 pass writes clusters, an L2 pass writes artifacts.
    produced: level === 'L1'
      ? { cluster_ids: outputIds, artifact_ids: [] }
      : { cluster_ids: [], artifact_ids: outputIds },
    queued_at: queuedAt,
    queue: COMPACTION_QUEUES[level as 'L1' | 'L2'] ?? level,
    repo: r['repo'] == null ? null : String(r['repo']),
    requested_by: r['requested_by'] == null ? null : String(r['requested_by']),
    input_ids: inputIds,
    output_ids: outputIds,
    log,
    what_changed: String(r['what_changed'] ?? ''),
    duration_ms: durationMs,
    cost_usd: costUsd,
    phase: (r['phase'] == null ? (status === 'succeeded' ? 'done' : status === 'failed' ? 'failed' : status === 'queued' ? 'queued' : 'claim') : String(r['phase'])) as CompactionPhase,
    percent: numOrNull(r['percent']),
    stepLabel: r['step_label'] == null ? null : String(r['step_label']),
    attempts: numOrNull(r['attempts']) ?? 0,
  };
}

async function readJobs(sql: string, params: SqlParameter[], nowMs: number): Promise<CompactionJob[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await exec(sql, params);
  } catch (err) {
    throw unavailable('compaction history', err);
  }
  try {
    return rows.map((r) => rowToCompactionJob(r, nowMs));
  } catch (err) {
    throw unavailable('compaction history', err);
  }
}

/** GET /compactions from distillation_compactions, newest first. */
export async function readCompactions(
  opts: { level?: Level; status?: CompactionStatus },
  nowMs: number,
): Promise<CompactionJob[]> {
  const where: string[] = [];
  const params: SqlParameter[] = [];
  if (opts.level) { where.push('level = :level'); params.push(str('level', opts.level)); }
  if (opts.status) { where.push('status = :status'); params.push(str('status', opts.status)); }
  params.push({ name: 'limit', value: { longValue: COMPACTION_LIST_LIMIT } });
  return readJobs(
    `SELECT ${COMPACTION_COLUMNS}
       FROM distillation_compactions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(started_at, queued_at) DESC, id DESC
      LIMIT :limit`,
    params,
    nowMs,
  );
}

/** GET /compactions/:id. null = no such row (a 404), not a failed read. */
export async function readCompaction(id: string, nowMs: number): Promise<CompactionJob | null> {
  const jobs = await readJobs(
    `SELECT ${COMPACTION_COLUMNS} FROM distillation_compactions WHERE id = :id`,
    [str('id', id)],
    nowMs,
  );
  return jobs[0] ?? null;
}

/** A stored writer, in the fields /ingest and /levels count from. */
export interface StoredWriter {
  id: string;
  session_id: string;
  box_id: string | null;
  repo: string;
  initiative_id: string | null;
  observationsPerHour: number;
  last_write_at: string;
}

/** Writers that landed an L0 row within `windowMs`, most recent first. The
 *  table keeps every writer ever seen, so "active" is a window over
 *  last_write_at, not the row count. */
export async function readRecentWriters(windowMs: number): Promise<StoredWriter[]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await exec(
      `SELECT id, session_id, box_id, repo, initiative_id,
              observations_per_hour, last_write_at
         FROM distillation_ingest_writers
        WHERE last_write_at >= NOW() - make_interval(secs => :window_s)
        ORDER BY last_write_at DESC, id`,
      [{ name: 'window_s', value: { longValue: Math.round(windowMs / 1000) } }],
    );
  } catch (err) {
    throw unavailable('ingest writers', err);
  }
  try {
    return rows.map((r) => {
      const rate = numOrNull(r['observations_per_hour']);
      if (rate == null) throw new Error(`observations_per_hour is not a number for writer ${String(r['id'])}`);
      return {
        id: String(r['id'] ?? ''),
        session_id: String(r['session_id'] ?? ''),
        box_id: r['box_id'] == null ? null : String(r['box_id']),
        repo: String(r['repo'] ?? ''),
        initiative_id: r['initiative_id'] == null ? null : String(r['initiative_id']),
        observationsPerHour: rate,
        last_write_at: isoRequired(r['last_write_at'], 'last_write_at'),
      };
    });
  } catch (err) {
    throw unavailable('ingest writers', err);
  }
}
