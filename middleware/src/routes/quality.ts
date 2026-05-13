// Quality routes — judge-score time series + human feedback writes.
//
// Mounted at /api/observability/quality (see routes/observability.ts).
//
//   GET  /scores?agentId=&since= → time-series of judge_score for one agent.
//   POST /feedback                → set human_label + human_note on a trace row.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';

export const qualityRouter = Router();

interface ScorePoint {
  invocationId: string;
  agentId: string;
  ts: string;
  judgeScore: number | null;
  schemaValid: boolean | null;
  humanLabel: string | null;
}

qualityRouter.get('/scores', asyncHandler(async (req, res) => {
  const agentId = (req.query['agentId'] as string | undefined)?.trim();
  const sinceRaw = (req.query['since'] as string | undefined)?.trim();
  // `since` is optional. Accept either an ISO timestamp or a number of
  // minutes ("60m"). Default = last 24 hours.
  let sinceClause = `ts > now() - INTERVAL '24 hours'`;
  const params: SqlParameter[] = [];

  if (sinceRaw) {
    const minutesMatch = sinceRaw.match(/^(\d+)m$/);
    if (minutesMatch) {
      params.push({ name: 'mins', value: { longValue: parseInt(minutesMatch[1]!, 10) } });
      sinceClause = `ts > now() - (INTERVAL '1 minute' * :mins)`;
    } else {
      // ISO timestamp
      const d = new Date(sinceRaw);
      if (Number.isFinite(d.getTime())) {
        params.push({ name: 'since_iso', value: { stringValue: d.toISOString() } });
        sinceClause = `ts > :since_iso::timestamptz`;
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
           judge_score, schema_valid, human_label
      FROM observability.invocation_traces
     WHERE ${sinceClause}
       AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
       ${whereAgent}
     ORDER BY ts ASC
     LIMIT 5000`;

  try {
    const rows = await exec(sql, params);
    const points: ScorePoint[] = rows.map((r) => ({
      invocationId: String(r['invocation_id'] ?? ''),
      agentId: String(r['agent_id'] ?? ''),
      ts: String(r['ts'] ?? ''),
      judgeScore: r['judge_score'] == null ? null : Number(r['judge_score']),
      schemaValid: r['schema_valid'] == null ? null : Boolean(r['schema_valid']),
      humanLabel: r['human_label'] == null ? null : String(r['human_label']),
    }));
    res.json({ points });
  } catch (err) {
    console.warn('[quality] /scores failed:', (err as Error).message);
    res.json({ points: [] });
  }
}));

const ALLOWED_LABELS = new Set(['good', 'bad', 'fixed']);

qualityRouter.post('/feedback', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    invocationId?: string;
    label?: string;
    note?: string;
  };

  const invocationId = (body.invocationId ?? '').trim();
  const label = (body.label ?? '').trim();
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';

  if (!invocationId) {
    throw new ValidationError('invocationId is required');
  }
  if (!/^[0-9a-f-]{36}$/i.test(invocationId)) {
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
