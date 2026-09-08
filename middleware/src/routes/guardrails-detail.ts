// Guardrail rule-level intervention routes.
//
// Mounted ungated at /api/observability/guardrails-detail (see index.ts).
// invocation_traces.guardrail_action is BLOCKED/ANONYMIZED/NONE — opaque.
// observability.guardrail_interventions has one row per rule that fired
// (a single invocation can have multiple). This router surfaces:
//   - by-rule breakdown (which rules fire most?)
//   - per-invocation drill-down (what rules fired on *this* row?)
//
// Endpoints:
//   GET /by-rule?windowHours=24
//   GET /interventions?invocationId=&ruleName=&limit=50
//
// Same defensive shape as memory.ts / cost.ts: every read swallows DB errors
// and returns an empty/zero response.

import { Router } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockGuardrailByRule,
  mockGuardrailInterventions,
} from '../mock/observability-queries.js';

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
  return { ...body, degraded: true, error: (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'query failed' };
}

export const guardrailsDetailRouter = Router();

// ── Types (mirrored client-side in GuardrailRulesPage) ─────────────────────

interface ByRuleEntry {
  ruleName: string;
  ruleCategory: string | null;
  count: number;
  severityCounts: { LOW: number; MEDIUM: number; HIGH: number };
}

interface GuardrailIntervention {
  interventionId: string;
  invocationId: string | null;
  agentId: string;
  ruleName: string;
  ruleCategory: string | null;
  severity: string | null;
  action: string;
  matchedText: string | null;
  ts: string;
}

// ── Param helpers ─────────────────────────────────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function longParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

function parseHours(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function parseLimit(raw: unknown, def: number, max: number): number {
  const n = parseInt(String(raw ?? def), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
function isValidUuid(s: string | undefined | null): s is string {
  return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
}

// ── GET /by-rule ──────────────────────────────────────────────────────────
//
// Top-firing rules over the window. severityCounts keyed by LOW/MEDIUM/HIGH
// so the portal can render a horizontal severity bar per rule.

guardrailsDetailRouter.get('/by-rule', asyncHandler(async (req, res) => {
  const windowHours = parseHours(req.query['windowHours'], 24, 24 * 14);

  const sql = `
    SELECT rule_name,
           MAX(rule_category) AS rule_category,
           COUNT(*)::bigint   AS cnt,
           COUNT(*) FILTER (WHERE severity = 'LOW')::bigint    AS low_cnt,
           COUNT(*) FILTER (WHERE severity = 'MEDIUM')::bigint AS med_cnt,
           COUNT(*) FILTER (WHERE severity = 'HIGH')::bigint   AS high_cnt
      FROM observability.guardrail_interventions
     WHERE ts > now() - (INTERVAL '1 hour' * :hours)
     GROUP BY rule_name
     ORDER BY cnt DESC`;

  try {
    const rows = config.mock.aurora
      ? mockGuardrailByRule(windowHours)
      : await exec(sql, [longParam('hours', windowHours)]);
    const byRule: ByRuleEntry[] = rows.map((r) => ({
      ruleName: String(r['rule_name'] ?? ''),
      ruleCategory: r['rule_category'] == null ? null : String(r['rule_category']),
      count: Number(r['cnt'] ?? 0),
      severityCounts: {
        LOW: Number(r['low_cnt'] ?? 0),
        MEDIUM: Number(r['med_cnt'] ?? 0),
        HIGH: Number(r['high_cnt'] ?? 0),
      },
    }));
    res.json({ byRule, windowHours });
  } catch (err) {
    console.warn('[guardrails-detail] /by-rule failed:', (err as Error).message);
    res.json(degraded({ byRule: [] as ByRuleEntry[], windowHours }, err));
  }
}));

// ── GET /interventions ────────────────────────────────────────────────────

guardrailsDetailRouter.get('/interventions', asyncHandler(async (req, res) => {
  const invocationId = isValidUuid(req.query['invocationId'] as string | undefined)
    ? (req.query['invocationId'] as string)
    : null;
  // The UUID guard above exists because the live query binds `:iid::uuid` and
  // Postgres would reject anything else. The mock corpus keys on the invocation
  // tail's ids (`mock-inv-33`), which are not UUIDs, so the offline branch
  // filters on the RAW id instead — otherwise clicking an intervention through
  // from a mock invocation silently dropped the filter and listed everything.
  const mockInvocationFilter = (req.query['invocationId'] as string | undefined)?.trim() || null;
  const ruleName = (req.query['ruleName'] as string | undefined)?.trim() || null;
  const limit = parseLimit(req.query['limit'], 50, 500);

  const wheres: string[] = [];
  const params: SqlParameter[] = [longParam('lim', limit)];
  if (invocationId) {
    wheres.push('invocation_id = :iid::uuid');
    params.push(strParam('iid', invocationId));
  }
  if (ruleName) {
    wheres.push('rule_name = :rule');
    params.push(strParam('rule', ruleName));
  }
  const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';

  const sql = `
    SELECT intervention_id::text   AS intervention_id,
           invocation_id::text     AS invocation_id,
           agent_id, rule_name, rule_category, severity, action,
           matched_text,
           ts::text                AS ts
      FROM observability.guardrail_interventions
     ${whereSql}
     ORDER BY ts DESC
     LIMIT :lim`;

  try {
    const rows = config.mock.aurora
      ? mockGuardrailInterventions(mockInvocationFilter, ruleName, limit)
      : await exec(sql, params);
    const interventions: GuardrailIntervention[] = rows.map((r) => ({
      interventionId: String(r['intervention_id'] ?? ''),
      invocationId: r['invocation_id'] == null ? null : String(r['invocation_id']),
      agentId: String(r['agent_id'] ?? ''),
      ruleName: String(r['rule_name'] ?? ''),
      ruleCategory: r['rule_category'] == null ? null : String(r['rule_category']),
      severity: r['severity'] == null ? null : String(r['severity']),
      action: String(r['action'] ?? ''),
      matchedText: r['matched_text'] == null ? null : String(r['matched_text']),
      ts: String(r['ts'] ?? ''),
    }));
    res.json({ interventions });
  } catch (err) {
    console.warn('[guardrails-detail] /interventions failed:', (err as Error).message);
    res.json(degraded({ interventions: [] as GuardrailIntervention[] }, err));
  }
}));
