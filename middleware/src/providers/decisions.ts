// Decisions provider — reads decisions + participants from Aurora PostgreSQL.
// Tables: decisions(id, topic, summary, decided_at, created_at)
//         decision_participants(person_id, decision_id, role, weight)
//         people(id, name, title, team)

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';

// ─── Local RDS Data API parameter helpers (mirroring aurora.ts internals) ────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DecisionSummary {
  id: string;
  topic: string;
  summary: string | null;
  decidedAt: string | null;
  participantCount: number;
}

export interface DecisionDetail {
  id: string;
  topic: string;
  summary: string | null;
  decidedAt: string | null;
  participants: Array<{
    personId: string;
    name: string;
    title: string | null;
    role: string | null;
    weight: number;
  }>;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function listDecisions(
  opts: { limit?: number; since?: string } = {},
): Promise<DecisionSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const params = [intParam('lim', limit)];
  let sinceClause = '';

  if (opts.since) {
    sinceClause = 'AND (d.decided_at >= :since OR (d.decided_at IS NULL AND d.created_at >= :since))';
    params.push(strParam('since', opts.since));
  }

  const sql = `
    SELECT
      d.id,
      d.topic,
      d.summary,
      d.decided_at,
      COUNT(dp.person_id)::int AS participant_count
    FROM decisions d
    LEFT JOIN decision_participants dp ON dp.decision_id = d.id
    WHERE 1=1
    ${sinceClause}
    GROUP BY d.id, d.topic, d.summary, d.decided_at
    ORDER BY COALESCE(d.decided_at, d.created_at) DESC NULLS LAST
    LIMIT :lim
  `;

  const rows = await exec(sql, params);
  return rows.map((r) => ({
    id: String(r['id']),
    topic: String(r['topic'] ?? ''),
    summary: r['summary'] != null ? String(r['summary']) : null,
    decidedAt: r['decided_at'] != null ? String(r['decided_at']) : null,
    participantCount: typeof r['participant_count'] === 'number' ? r['participant_count'] : 0,
  }));
}

export async function getDecision(id: string): Promise<DecisionDetail | null> {
  const headRows = await exec(
    `SELECT id, topic, summary, decided_at FROM decisions WHERE id = :id LIMIT 1`,
    [strParam('id', id)],
  );

  if (headRows.length === 0) return null;
  const head = headRows[0]!;

  const partRows = await exec(
    `SELECT
       dp.person_id,
       p.name,
       p.title,
       dp.role,
       COALESCE(dp.weight, 1.0)::double precision AS weight
     FROM decision_participants dp
     JOIN people p ON p.id = dp.person_id
     WHERE dp.decision_id = :id
     ORDER BY dp.weight DESC NULLS LAST, p.name`,
    [strParam('id', id)],
  );

  return {
    id: String(head['id']),
    topic: String(head['topic'] ?? ''),
    summary: head['summary'] != null ? String(head['summary']) : null,
    decidedAt: head['decided_at'] != null ? String(head['decided_at']) : null,
    participants: partRows.map((r) => ({
      personId: String(r['person_id']),
      name: String(r['name'] ?? ''),
      title: r['title'] != null ? String(r['title']) : null,
      role: r['role'] != null ? String(r['role']) : null,
      weight: typeof r['weight'] === 'number' ? r['weight'] : 1.0,
    })),
  };
}
