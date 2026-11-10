// Quality routes — judge-score time series + human feedback writes.
//
// Mounted at /api/observability/quality (see routes/observability.ts).
//
//   GET  /scores?agentId=&since= → time-series of judge_score for one agent.
//   POST /feedback                → set human_label + human_note on a trace row.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { mockQualityScores } from '../mock/observability-queries.js';
import { clock } from '../mock/core/clock.js';
import { mockSetHumanLabel, traceRows } from '../mock/observability.js';

import { reasonLine } from '../lib/upstream.js';
import { traceScope, rowInScope } from '../lib/trace-scope.js';
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

export const qualityRouter = Router();

interface ScorePoint {
  invocationId: string;
  agentId: string;
  ts: string;
  judgeScore: number | null;
  schemaValid: boolean | null;
  humanLabel: string | null;
  // The Quality page has always rendered RATIONALE and COST columns and this
  // route has never returned either, so both were empty on every row of every
  // deployment — not a mock gap: the SQL did not select them and the mock
  // selector dropped exactly the same fields, so the two agreed and the wire
  // check had nothing to disagree with. Every column below exists on
  // `observability.invocation_traces` (judge_rationale since the original
  // schema, the rest since observability_sprint1_schema.sql). The page's
  // "nullable until the migration lands" comment was stale; it landed.
  //
  // The rationale is the point of a quality page: a score of 0.73 is a number,
  // and why the judge gave it is the thing a person can act on.
  judgeRationale: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estCostUsd: number | null;
  judgeCostUsd: number | null;
  totalCostUsd: number | null;
  promptVersion: string | null;
  modelId: string | null;
}

qualityRouter.get('/scores', asyncHandler(async (req, res) => {
  const agentId = (req.query['agentId'] as string | undefined)?.trim();
  // Every point stays (the chart is an aggregate), but the judge's rationale
  // quotes the prompt and answer: it is returned only for the caller's own
  // rows (lib/trace-scope.ts).
  const scope = traceScope(req, res);
  if (scope === 'refused') return;
  const sinceRaw = (req.query['since'] as string | undefined)?.trim();
  // `since` is optional. Accept either an ISO timestamp or a number of
  // minutes ("60m"). Default = last 24 hours.
  let sinceClause = `ts > now() - INTERVAL '24 hours'`;
  const params: SqlParameter[] = [];
  // The same cutoff the SQL expresses as an INTERVAL, in ms, for the offline
  // branch. Computed from the SAME parse below so the two windows cannot
  // disagree about what `since=60m` means.
  //
  // "Now" is the MOCK clock's now when the offline branch is the one that will
  // answer, and real time otherwise. Against Aurora the SQL says `now()` and
  // this value is unused; against the fixtures the rows are stamped from
  // mock/core/clock.ts, so measuring their age with `Date.now()` compares two
  // different clocks. That is not hypothetical: a test freezing the mock clock
  // at a fixed instant kept passing only while real time stayed within 24h of
  // it, then began returning zero rows for every window once wall-clock passed
  // the hard-coded date — a suite with a 24-hour shelf life. `clock.now()`
  // returns real time when nothing is frozen, so this is a no-op in production.
  const nowMs = (): number => (config.mock.aurora ? clock.now().getTime() : Date.now());
  let sinceMs = nowMs() - 24 * 3_600_000;

  if (sinceRaw) {
    const minutesMatch = sinceRaw.match(/^(\d+)m$/);
    if (minutesMatch) {
      const mins = parseInt(minutesMatch[1]!, 10);
      params.push({ name: 'mins', value: { longValue: mins } });
      sinceClause = `ts > now() - (INTERVAL '1 minute' * :mins)`;
      sinceMs = nowMs() - mins * 60_000;
    } else {
      // ISO timestamp
      const d = new Date(sinceRaw);
      if (Number.isFinite(d.getTime())) {
        params.push({ name: 'since_iso', value: { stringValue: d.toISOString() } });
        sinceClause = `ts > :since_iso::timestamptz`;
        sinceMs = d.getTime();
      }
    }
  }

  let whereAgent = '';
  if (agentId) {
    whereAgent = 'AND agent_id = :agent';
    params.push({ name: 'agent', value: { stringValue: agentId } });
  }

  const sql = `
    SELECT invocation_id::text AS invocation_id,
           agent_id, ts,
           judge_score, schema_valid, human_label,
           judge_rationale, user_id, tenant,
           input_tokens, output_tokens,
           est_cost_usd, judge_cost_usd, total_cost_usd,
           prompt_version, model_id
      FROM observability.invocation_traces
     WHERE ${sinceClause}
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
       ${whereAgent}
     ORDER BY ts ASC
     LIMIT 5000`;

  try {
    const rows = config.mock.aurora
      ? mockQualityScores(sinceMs, agentId)
      : await exec(sql, params);
    const points: ScorePoint[] = rows.map((r) => ({
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      ts: String(r['ts'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      schemaValid: r['schema_valid'] == null ? null : Boolean(r['schema_valid']),
      humanLabel: r['human_label'] == null ? null : String(r['human_label']),
      judgeRationale: r['judge_rationale'] == null || !rowInScope(scope, r) ? null : String(r['judge_rationale']),
      inputTokens: r['input_tokens'] == null ? null : Number(r['input_tokens']),
      outputTokens: r['output_tokens'] == null ? null : Number(r['output_tokens']),
      estCostUsd: r['est_cost_usd'] == null ? null : Number(r['est_cost_usd']),
      judgeCostUsd: r['judge_cost_usd'] == null ? null : Number(r['judge_cost_usd']),
      totalCostUsd: r['total_cost_usd'] == null ? null : Number(r['total_cost_usd']),
      promptVersion: r['prompt_version'] == null ? null : String(r['prompt_version']),
      modelId: r['model_id'] == null ? null : String(r['model_id']),
    }));
    res.json({ points });
  } catch (err) {
    console.warn('[quality] /scores failed:', (err as Error).message);
    res.json(degraded({ points: [] as ScorePoint[] }, err));
  }
}));

const ALLOWED_LABELS = new Set(['good', 'bad', 'fixed']);

// Writing a human label onto a trace is the LabelFeedback action — the one
// endpoint that consumes that grant. (The router already sits behind the
// observability mount's tenant + ViewObservability gate; this makes the
// action explicit so LabelFeedback is enforced, not a decorative grant.)
qualityRouter.post('/feedback', requireAction('LabelFeedback'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    invocationId?: string;
    runId?: string;
    label?: string;
    note?: string;
  };

  const label = (body.label ?? '').trim();
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
  const runId = typeof body.runId === 'string' ? body.runId.trim().slice(0, 200) : '';

  // By RUN (pipelines P1). The Ask page holds the AG-UI run id of the answer
  // it just streamed, not the trace uuid — the two were disjoint until the
  // bundle began carrying `runId` (agui_run_id), which is what LabelFeedback
  // was waiting on (docs/program-operating-model.md). A run resolves to its
  // run's own trace — the earliest row with that run id, not a sub-agent's —
  // and only among the CALLER'S OWN runs: a run id is an opaque id the member
  // was handed on their own stream, and labelling by it must not reach anyone
  // else's trace. Not found is a 404 that says the bundle may still be on its
  // way (the CloudWatch poller lags ~30s), not a claim the run never happened.
  if (!body.invocationId && runId) {
    if (!ALLOWED_LABELS.has(label)) {
      throw new ValidationError(`label must be one of: ${Array.from(ALLOWED_LABELS).join(', ')}`);
    }
    const sub = req.session?.sub ?? null;
    if (!sub) throw new ValidationError('labelling by runId needs a signed-in session');
    const notYet = 'no trace recorded for that run yet — the agent\'s trace bundle may still be on its way';
    if (config.mock.aurora) {
      const own = traceRows()
        .filter((r) => r.agui_run_id === runId && r.user_id === sub)
        .sort((a, b) => a.tsIso.localeCompare(b.tsIso))[0];
      if (!own || !mockSetHumanLabel(own.invocation_id, label, note || null)) throw new NotFoundError(notYet);
      res.json({ ok: true, invocationId: own.invocation_id, runId, label, note });
      return;
    }
    const rows = await exec(
      `UPDATE observability.invocation_traces
          SET human_label = :label, human_note = :note
        WHERE invocation_id = (
          SELECT invocation_id FROM observability.invocation_traces
           WHERE agui_run_id = :rid AND user_id = :sub
           ORDER BY ts ASC LIMIT 1)
       RETURNING invocation_id::text AS invocation_id`,
      [
        { name: 'rid', value: { stringValue: runId } },
        { name: 'sub', value: { stringValue: sub } },
        { name: 'label', value: { stringValue: label } },
        note ? { name: 'note', value: { stringValue: note } } : { name: 'note', value: { isNull: true } },
      ],
    );
    if (rows.length === 0) throw new NotFoundError(notYet);
    res.json({ ok: true, invocationId: String(rows[0]!['invocation_id']), runId, label, note });
    return;
  }

  const invocationId = (body.invocationId ?? '').trim();
  if (!invocationId) {
    throw new ValidationError('invocationId is required (or the runId of your own answer)');
  }
  // The UUID shape is a precondition of the live UPDATE's `:iid::uuid` bind,
  // not of the feature. Offline the ids are the invocation tail's
  // (`mock-inv-33`), so the check is scoped to the path that needs it —
  // otherwise labelling was rejected for every row `dev:mock` can actually
  // show, which is every row.
  if (!config.mock.aurora && !/^[0-9a-f-]{36}$/i.test(invocationId)) {
    throw new ValidationError('invocationId must be a UUID');
  }
  if (!ALLOWED_LABELS.has(label)) {
    throw new ValidationError(`label must be one of: ${Array.from(ALLOWED_LABELS).join(', ')}`);
  }

  const sql = `
    UPDATE observability.invocation_traces
       SET human_label = :label,
           human_note = :note
     WHERE invocation_id = :iid::uuid
    RETURNING invocation_id::text AS invocation_id`;

  // Offline, the label is upserted into the `observability-human-labels`
  // fixture, so the next GET /scores and the Invocations detail both show it
  // and `POST /api/__mock/reset` takes it back off again. `RETURNING` missing
  // is a 404 on both paths.
  if (config.mock.aurora) {
    if (!mockSetHumanLabel(invocationId, label, note || null)) {
      throw new NotFoundError('invocation not found');
    }
    res.json({ ok: true, invocationId, label, note });
    return;
  }

  const rows = await exec(sql, [
    { name: 'iid', value: { stringValue: invocationId } },
    { name: 'label', value: { stringValue: label } },
    note
      ? { name: 'note', value: { stringValue: note } }
      : { name: 'note', value: { isNull: true } },
  ]);

  if (rows.length === 0) {
    throw new NotFoundError('invocation not found');
  }

  res.json({ ok: true, invocationId, label, note });
}));
