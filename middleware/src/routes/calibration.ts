// Sprint 4 (M10) — judge calibration routes.
//
// A calibration_set is a small (~20) corpus of (prompt, response, human_score)
// tuples hand-graded by a researcher. The Nova-Pro judge is re-run over the
// active set on demand; we record per-case abs_error vs human_score and a
// run-level MAE. When MAE creeps past 0.15 the historical quality scores
// have lost their meaning — the judge has drifted.
//
// Mounted at /api/observability/calibration BEFORE the gated
// /api/observability mount in index.ts (same pattern as cost/harness).
// Defensive: every endpoint absorbs Aurora misses and returns empty/zero so
// the portal can render before the schema migration has been applied.
//
// Endpoints:
//   GET    /cases             list active cases
//   GET    /cases/:id         fetch one
//   POST   /cases             insert
//   PATCH  /cases/:id         partial update
//   DELETE /cases/:id         soft delete (active=false)
//
//   POST   /runs              run judge over all active cases, write
//                              calibration_results + summarize the run
//   GET    /runs?limit=14     recent runs
//   GET    /runs/:id          run + results + joined case data

import { Router } from 'express';
import { requireAction } from '../lib/authz.js';
import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockCalibrationCase,
  mockCalibrationCases,
  mockCalibrationResults,
  mockCalibrationRun,
  mockCalibrationRuns,
  mockDeactivateCalibrationCase,
  mockInsertCalibrationCase,
  mockUpdateCalibrationCase,
} from '../mock/calibration.js';
import { judgeResponse, NOVA_PRO_MODEL_ID } from '../lib/judge.js';

import { reasonLine } from '../lib/upstream.js';
/**
 * Marks a response whose query failed — the wrapper from routes/cost.ts, kept
 * local so each router owns its own copy.
 *
 * Every read below answers 200 with an empty payload rather than failing the
 * page, which is the right call. What it cost was the difference between
 * "nothing happened in this window" and "the query blew up": both rendered as
 * an empty panel. The marker restores it without touching the healthy shape —
 * a quiet window answers exactly as it did before, and only a caught failure
 * carries `degraded` + the first line of the error.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: reasonLine(err) };
}

export const calibrationRouter = Router();

// ─── Parameter helpers (mirror harness.ts) ──────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function nullableStr(name: string, value: string | null | undefined): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  return { name, value: { stringValue: value } };
}
function nullableNumber(name: string, value: number | null | undefined): SqlParameter {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { doubleValue: value } };
}
function nullableInt(name: string, value: number | null | undefined): SqlParameter {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { name, value: { isNull: true } };
  }
  return { name, value: { longValue: Math.round(value) } };
}
function boolParam(name: string, value: boolean): SqlParameter {
  return { name, value: { booleanValue: value } };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampLimit(raw: string | undefined, defLimit = 14, maxLimit = 100): number {
  const n = parseInt(raw ?? String(defLimit), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maxLimit) : defLimit;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CalibrationCase {
  calibrationId: string;
  agentId: string;
  prompt: string;
  response: string;
  humanScore: number;
  humanRationale: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

export interface CalibrationRun {
  calibrationRunId: string;
  label: string;
  judgeModelId: string;
  totalCases: number;
  meanAbsError: number | null;
  maxAbsError: number | null;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
}

export interface CalibrationResult {
  calibrationRunId: string;
  calibrationId: string;
  judgeScore: number | null;
  judgeRationale: string | null;
  absError: number | null;
  // Joined from calibration_set so the UI can render the scatter / disagreement
  // table without a second fetch.
  agentId?: string;
  prompt?: string;
  response?: string;
  humanScore?: number;
  humanRationale?: string | null;
}

// ─── Row coercion ───────────────────────────────────────────────────────────

function rowToCase(r: Record<string, unknown>): CalibrationCase {
  return {
    calibrationId: String(r['calibration_id'] ?? ''),
    agentId: String(r['agent_id'] ?? ''),
    prompt: String(r['prompt'] ?? ''),
    response: String(r['response'] ?? ''),
    humanScore: r['human_score'] == null ? 0 : Number(r['human_score']),
    humanRationale: r['human_rationale'] == null ? null : String(r['human_rationale']),
    active: r['active'] == null ? true : Boolean(r['active']),
    createdAt: String(r['created_at'] ?? ''),
    updatedAt: String(r['updated_at'] ?? ''),
    notes: r['notes'] == null ? null : String(r['notes']),
  };
}

function rowToRun(r: Record<string, unknown>): CalibrationRun {
  return {
    calibrationRunId: String(r['calibration_run_id'] ?? ''),
    label: String(r['label'] ?? ''),
    judgeModelId: String(r['judge_model_id'] ?? ''),
    totalCases: Number(r['total_cases'] ?? 0),
    meanAbsError: r['mean_abs_error'] == null ? null : Number(r['mean_abs_error']),
    maxAbsError: r['max_abs_error'] == null ? null : Number(r['max_abs_error']),
    startedAt: String(r['started_at'] ?? ''),
    finishedAt: r['finished_at'] == null ? null : String(r['finished_at']),
    notes: r['notes'] == null ? null : String(r['notes']),
  };
}

function rowToResult(r: Record<string, unknown>): CalibrationResult {
  const out: CalibrationResult = {
    calibrationRunId: String(r['calibration_run_id'] ?? ''),
    calibrationId: String(r['calibration_id'] ?? ''),
    judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
    judgeRationale: r['judge_rationale'] == null ? null : String(r['judge_rationale']),
    absError: r['abs_error'] == null ? null : Number(r['abs_error']),
  };
  if (r['agent_id'] != null) out.agentId = String(r['agent_id']);
  if (r['prompt'] != null) out.prompt = String(r['prompt']);
  if (r['response'] != null) out.response = String(r['response']);
  if (r['human_score'] != null) out.humanScore = Number(r['human_score']);
  if (r['human_rationale'] != null) out.humanRationale = String(r['human_rationale']);
  return out;
}

// ─── GET /cases ─────────────────────────────────────────────────────────────

calibrationRouter.get('/cases', asyncHandler(async (req, res) => {
  const includeInactive = req.query['includeInactive'] === '1'
    || req.query['includeInactive'] === 'true';
  const sql = `
    SELECT calibration_id::text   AS calibration_id,
           agent_id, prompt, response,
           human_score::text      AS human_score,
           human_rationale, active,
           created_at::text       AS created_at,
           updated_at::text       AS updated_at,
           notes
      FROM observability.calibration_set
     ${includeInactive ? '' : 'WHERE active = true'}
     ORDER BY agent_id ASC, created_at ASC`;
  try {
    const rows = config.mock.aurora
      ? mockCalibrationCases(includeInactive)
      : await exec(sql, []);
    res.json({ cases: rows.map(rowToCase) });
  } catch (err) {
    console.warn('[calibration] /cases failed:', (err as Error).message);
    res.json(degraded({ cases: [] as CalibrationCase[] }, err));
  }
}));

// ─── GET /cases/:id ─────────────────────────────────────────────────────────

calibrationRouter.get('/cases/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const rows = config.mock.aurora
    ? mockCalibrationCase(id)
    : await exec(
      `SELECT calibration_id::text   AS calibration_id,
              agent_id, prompt, response,
              human_score::text      AS human_score,
              human_rationale, active,
              created_at::text       AS created_at,
              updated_at::text       AS updated_at,
              notes
         FROM observability.calibration_set
        WHERE calibration_id = CAST(:id AS uuid)`,
      [strParam('id', id)],
    );
  if (rows.length === 0) {
    res.status(404).json({ error: 'calibration case not found' });
    return;
  }
  res.json({ case: rowToCase(rows[0]!) });
}));

// ─── POST /cases — insert ───────────────────────────────────────────────────

interface UpsertCaseBody {
  agentId?: string;
  prompt?: string;
  response?: string;
  humanScore?: number;
  humanRationale?: string | null;
  active?: boolean;
  notes?: string | null;
}

calibrationRouter.post('/cases', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as UpsertCaseBody;
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const response = typeof body.response === 'string' ? body.response : '';
  if (!agentId) throw new ValidationError('agentId is required');
  if (!prompt) throw new ValidationError('prompt is required');
  if (typeof body.response !== 'string') {
    throw new ValidationError('response is required');
  }
  if (typeof body.humanScore !== 'number' || !Number.isFinite(body.humanScore)) {
    throw new ValidationError('humanScore is required (0..1)');
  }
  const humanScore = clamp01(body.humanScore);
  const active = typeof body.active === 'boolean' ? body.active : true;

  const calibrationId = randomUUID();
  if (config.mock.aurora) {
    mockInsertCalibrationCase({
      calibrationId, agentId, prompt, response, humanScore,
      humanRationale: body.humanRationale ?? null, active, notes: body.notes ?? null,
    });
    res.status(201).json({ calibrationId });
    return;
  }
  await exec(
    `INSERT INTO observability.calibration_set
       (calibration_id, agent_id, prompt, response, human_score,
        human_rationale, active, notes,
        created_at, updated_at)
     VALUES
       (CAST(:calibration_id AS uuid), :agent_id, :prompt, :response,
        :human_score, :human_rationale, :active, :notes, now(), now())`,
    [
      strParam('calibration_id', calibrationId),
      strParam('agent_id', agentId),
      strParam('prompt', prompt),
      strParam('response', response),
      nullableNumber('human_score', humanScore),
      nullableStr('human_rationale', body.humanRationale ?? null),
      boolParam('active', active),
      nullableStr('notes', body.notes ?? null),
    ],
  );
  res.status(201).json({ calibrationId });
}));

// ─── PATCH /cases/:id ───────────────────────────────────────────────────────

calibrationRouter.patch('/cases/:id', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const body = (req.body ?? {}) as UpsertCaseBody;
  const sets: string[] = [];
  const params: SqlParameter[] = [strParam('id', id)];

  if (typeof body.agentId === 'string') {
    sets.push('agent_id = :agent_id');
    params.push(strParam('agent_id', body.agentId));
  }
  if (typeof body.prompt === 'string') {
    sets.push('prompt = :prompt');
    params.push(strParam('prompt', body.prompt));
  }
  if (typeof body.response === 'string') {
    sets.push('response = :response');
    params.push(strParam('response', body.response));
  }
  if (typeof body.humanScore === 'number' && Number.isFinite(body.humanScore)) {
    sets.push('human_score = :human_score');
    params.push(nullableNumber('human_score', clamp01(body.humanScore)));
  }
  if ('humanRationale' in body) {
    sets.push('human_rationale = :human_rationale');
    params.push(nullableStr('human_rationale', body.humanRationale ?? null));
  }
  if (typeof body.active === 'boolean') {
    sets.push('active = :active');
    params.push(boolParam('active', body.active));
  }
  if ('notes' in body) {
    sets.push('notes = :notes');
    params.push(nullableStr('notes', body.notes ?? null));
  }

  if (sets.length === 0) {
    res.json({ ok: true, changed: 0 });
    return;
  }
  sets.push('updated_at = now()');

  if (config.mock.aurora) {
    const patch: Parameters<typeof mockUpdateCalibrationCase>[1] = {};
    if (typeof body.agentId === 'string') patch.agentId = body.agentId;
    if (typeof body.prompt === 'string') patch.prompt = body.prompt;
    if (typeof body.response === 'string') patch.response = body.response;
    if (typeof body.humanScore === 'number' && Number.isFinite(body.humanScore)) {
      patch.humanScore = clamp01(body.humanScore);
    }
    if ('humanRationale' in body) patch.humanRationale = body.humanRationale ?? null;
    if (typeof body.active === 'boolean') patch.active = body.active;
    if ('notes' in body) patch.notes = body.notes ?? null;
    if (!mockUpdateCalibrationCase(id, patch)) throw new NotFoundError('calibration case not found');
    res.json({ ok: true });
    return;
  }

  const rows = await exec(
    `UPDATE observability.calibration_set
        SET ${sets.join(', ')}
      WHERE calibration_id = CAST(:id AS uuid)
      RETURNING calibration_id`,
    params,
  );
  if (rows.length === 0) throw new NotFoundError('calibration case not found');
  res.json({ ok: true });
}));

// ─── DELETE /cases/:id — soft delete ────────────────────────────────────────

calibrationRouter.delete('/cases/:id', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (config.mock.aurora) {
    if (!mockDeactivateCalibrationCase(id)) throw new NotFoundError('calibration case not found');
    res.json({ ok: true });
    return;
  }
  const rows = await exec(
    `UPDATE observability.calibration_set
        SET active = false, updated_at = now()
      WHERE calibration_id = CAST(:id AS uuid)
      RETURNING calibration_id`,
    [strParam('id', id)],
  );
  if (rows.length === 0) throw new NotFoundError('calibration case not found');
  res.json({ ok: true });
}));

// ─── POST /runs — execute judge over all active cases ──────────────────────
//
// Synchronous (small dataset, ~20 cases). Each case is judged via judgeResponse
// — Nova-Pro by default; pass judgeModelId to override (only nova-pro is
// implemented today, so non-nova-pro values get logged but still hit Nova).
// For each case we compute abs_error = |judge_score - human_score|; the run-
// level mean_abs_error + max_abs_error get stamped on the calibration_runs row.

interface CreateRunBody {
  label?: string;
  judgeModelId?: string;
  notes?: string | null;
}

calibrationRouter.post('/runs', requireAction('ManageCanary'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as CreateRunBody;
  const label = typeof body.label === 'string' && body.label.trim()
    ? body.label.trim()
    : `manual@${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const judgeModelId = typeof body.judgeModelId === 'string' && body.judgeModelId.trim()
    ? body.judgeModelId.trim()
    : NOVA_PRO_MODEL_ID;

  // 1. Load active cases. If empty, refuse — running a calibration over zero
  //    cases is always operator error.
  let activeCases: CalibrationCase[] = [];
  try {
    const rows = config.mock.aurora ? mockCalibrationCases(false) : await exec(
      `SELECT calibration_id::text AS calibration_id,
              agent_id, prompt, response,
              human_score::text AS human_score,
              human_rationale, active,
              created_at::text AS created_at,
              updated_at::text AS updated_at,
              notes
         FROM observability.calibration_set
        WHERE active = true
        ORDER BY created_at ASC`,
      [],
    );
    activeCases = rows.map(rowToCase);
  } catch (err) {
    console.warn('[calibration] failed to load cases for run:', (err as Error).message);
    res.status(503).json({ error: 'calibration_set unavailable', detail: (err as Error).message });
    return;
  }

  if (activeCases.length === 0) {
    res.status(400).json({ error: 'no active calibration cases — seed the set first' });
    return;
  }

  // THE ONE READ/WRITE ON THIS SURFACE THAT STAYS DEGRADED OFFLINE, with its
  // true reason. A calibration run is not a query: it re-invokes the Nova-Pro
  // judge once per active case (lib/judge.ts → bedrock-runtime Converse) and
  // records what the judge actually said. There is no Bedrock in `dev:mock`,
  // and a synthesised MAE would be a number about a judge nobody ran — which
  // is exactly the fabrication this page exists to detect. The reads around it
  // (`GET /cases`, `GET /runs`, `GET /runs/:id`) are fully seeded, so the
  // surface is legible; only the button that spends money is refused.
  if (config.mock.aurora) {
    res.status(503).json({
      error: 'calibration runs invoke the Nova-Pro judge — no Bedrock in dev:mock',
      detail: `${activeCases.length} active case(s) would be re-judged against amazon.nova-pro-v1:0. `
        + 'Run this against a deployed stack; the seeded run history is readable offline.',
    });
    return;
  }

  // 2. Insert the run row up front (status implicit via started_at / finished_at).
  const calibrationRunId = randomUUID();
  await exec(
    `INSERT INTO observability.calibration_runs
       (calibration_run_id, label, judge_model_id, total_cases,
        started_at, notes)
     VALUES
       (CAST(:run_id AS uuid), :label, :judge_model_id, :total_cases,
        now(), :notes)`,
    [
      strParam('run_id', calibrationRunId),
      strParam('label', label),
      strParam('judge_model_id', judgeModelId),
      nullableInt('total_cases', activeCases.length),
      nullableStr('notes', body.notes ?? null),
    ],
  );

  // 3. For each case, call the judge sequentially. Failures land as a result
  //    row with null judge_score + null abs_error so the UI can still render
  //    the row and the operator can see which case the judge failed on.
  let sumAbs = 0;
  let countAbs = 0;
  let maxAbs = 0;

  for (const c of activeCases) {
    const judgement = await judgeResponse(c.prompt, c.response).catch(() => null);
    const judgeScore = judgement ? clamp01(judgement.score) : null;
    const judgeRationale = judgement ? judgement.rationale : null;
    let absError: number | null = null;
    if (judgeScore != null && Number.isFinite(c.humanScore)) {
      absError = Math.abs(judgeScore - c.humanScore);
      sumAbs += absError;
      countAbs += 1;
      if (absError > maxAbs) maxAbs = absError;
    }

    await exec(
      `INSERT INTO observability.calibration_results
         (calibration_run_id, calibration_id, judge_score, judge_rationale, abs_error)
       VALUES
         (CAST(:run_id AS uuid), CAST(:calibration_id AS uuid),
          :judge_score, :judge_rationale, :abs_error)
       ON CONFLICT (calibration_run_id, calibration_id) DO UPDATE SET
          judge_score = EXCLUDED.judge_score,
          judge_rationale = EXCLUDED.judge_rationale,
          abs_error = EXCLUDED.abs_error`,
      [
        strParam('run_id', calibrationRunId),
        strParam('calibration_id', c.calibrationId),
        nullableNumber('judge_score', judgeScore),
        nullableStr('judge_rationale', judgeRationale),
        nullableNumber('abs_error', absError),
      ],
    );
  }

  // 4. Stamp the run summary.
  const meanAbsError = countAbs > 0 ? sumAbs / countAbs : null;
  const maxAbsError = countAbs > 0 ? maxAbs : null;
  await exec(
    `UPDATE observability.calibration_runs
        SET mean_abs_error = :mean_abs_error,
            max_abs_error = :max_abs_error,
            finished_at = now()
      WHERE calibration_run_id = CAST(:run_id AS uuid)`,
    [
      strParam('run_id', calibrationRunId),
      nullableNumber('mean_abs_error', meanAbsError),
      nullableNumber('max_abs_error', maxAbsError),
    ],
  );

  res.status(201).json({
    calibrationRunId,
    totalCases: activeCases.length,
    meanAbsError,
    maxAbsError,
  });
}));

// ─── GET /runs?limit=14 ─────────────────────────────────────────────────────

calibrationRouter.get('/runs', asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query['limit'] as string | undefined);
  try {
    const rows = config.mock.aurora
      ? mockCalibrationRuns(limit)
      : await exec(
        `SELECT calibration_run_id::text AS calibration_run_id,
                label, judge_model_id, total_cases,
                mean_abs_error::text AS mean_abs_error,
                max_abs_error::text  AS max_abs_error,
                started_at::text     AS started_at,
                finished_at::text    AS finished_at,
                notes
           FROM observability.calibration_runs
          ORDER BY started_at DESC
          LIMIT :lim`,
        [{ name: 'lim', value: { longValue: limit } }],
      );
    res.json({ runs: rows.map(rowToRun) });
  } catch (err) {
    console.warn('[calibration] /runs failed:', (err as Error).message);
    res.json(degraded({ runs: [] as CalibrationRun[] }, err));
  }
}));

// ─── GET /runs/:id — run + joined results ──────────────────────────────────

calibrationRouter.get('/runs/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');

  const runRows = config.mock.aurora ? mockCalibrationRun(id) : await exec(
    `SELECT calibration_run_id::text AS calibration_run_id,
            label, judge_model_id, total_cases,
            mean_abs_error::text AS mean_abs_error,
            max_abs_error::text  AS max_abs_error,
            started_at::text     AS started_at,
            finished_at::text    AS finished_at,
            notes
       FROM observability.calibration_runs
      WHERE calibration_run_id = CAST(:id AS uuid)`,
    [strParam('id', id)],
  );
  if (runRows.length === 0) {
    res.status(404).json({ error: 'calibration run not found' });
    return;
  }

  const resultRows = config.mock.aurora ? mockCalibrationResults(id) : await exec(
    `SELECT r.calibration_run_id::text AS calibration_run_id,
            r.calibration_id::text     AS calibration_id,
            r.judge_score::text        AS judge_score,
            r.judge_rationale,
            r.abs_error::text          AS abs_error,
            c.agent_id, c.prompt, c.response,
            c.human_score::text        AS human_score,
            c.human_rationale
       FROM observability.calibration_results r
       JOIN observability.calibration_set c ON c.calibration_id = r.calibration_id
      WHERE r.calibration_run_id = CAST(:id AS uuid)
      ORDER BY r.abs_error DESC NULLS LAST, c.agent_id ASC`,
    [strParam('id', id)],
  );

  res.json({
    run: rowToRun(runRows[0]!),
    results: resultRows.map(rowToResult),
  });
}));
