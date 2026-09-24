// Durable mirror of distillation's operational rows
// (schema/distillation_ops_schema.sql): compaction job records and the L0
// write-stream's writers.
//
// Scope, stated plainly: the distillation READ path is still mock-first
// (providers/distillation.ts's module note) — observations, clusters and
// artifacts are fixture rows, so a job's produced ids point into those. What
// this mirror adds is a durable record of what the queue consumer did (every
// transition upserts the job, in the same shape `GET /compactions` serves) and
// of who has been writing L0, so an operator can query history across
// restarts. Reading these tables back as the source of truth is the step
// after the corpus itself moves to Aurora.
//
// Same degradation contract as providers/devbox-fleet-store.ts: Aurora mocked,
// unconfigured or down leaves compaction working exactly as before. Every call
// is fire-and-forget and nothing throws back into the consumer.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';

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
        input_ids, output_ids, log, what_changed, duration_ms, cost_usd, error, attempts)
     VALUES (:id, :level, :repo, :status, :phase, :percent, :requested_by, :queued_at::timestamptz,
        :started_at::timestamptz, :finished_at::timestamptz,
        ARRAY(SELECT jsonb_array_elements_text(:input_ids::jsonb)),
        ARRAY(SELECT jsonb_array_elements_text(:output_ids::jsonb)),
        :log::jsonb, :what_changed, :duration_ms, :cost_usd, :error, :attempts)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status, phase = EXCLUDED.phase, percent = EXCLUDED.percent,
       started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
       input_ids = EXCLUDED.input_ids, output_ids = EXCLUDED.output_ids, log = EXCLUDED.log,
       what_changed = EXCLUDED.what_changed, duration_ms = EXCLUDED.duration_ms,
       cost_usd = EXCLUDED.cost_usd, error = EXCLUDED.error, attempts = EXCLUDED.attempts`,
    [
      str('id', job.id), str('level', job.level), str('repo', job.repo), str('status', job.status),
      str('phase', job.phase), num('percent', job.percent), str('requested_by', job.requested_by),
      str('queued_at', job.queued_at), str('started_at', started), str('finished_at', job.finishedAt),
      str('input_ids', JSON.stringify(job.input_ids)), str('output_ids', JSON.stringify(job.output_ids)),
      str('log', JSON.stringify(job.log)), str('what_changed', job.what_changed),
      num('duration_ms', job.duration_ms), num('cost_usd', job.cost_usd), str('error', job.error ?? null),
      num('attempts', job.attempts),
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
