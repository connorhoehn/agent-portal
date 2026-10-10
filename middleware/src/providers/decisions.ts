// Decisions provider — reads decisions + participants from Aurora PostgreSQL.
// Tables: decisions(id, topic, summary, status, project_id, decided_at, ...)
//         decision_participants(person_id, decision_id, role, weight)
//         people(id, name, title, team)
//
// `decisions` is ONE concept with a lifecycle — see the comment on the table in
// schema/orgiq_schema.sql. This provider serves the whole table, settled ADRs
// and open calls alike; `providers/work-items.ts` serves the same rows filtered
// to one initiative. Both report `status` and `projectId` so the two surfaces
// can be recognised as views of one list rather than two unrelated ones.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { exec } from './aurora.js';
import { countBy } from '../mock/core/index.js';
import { decisionRows, decisionParticipantRows } from '../mock/decisions.js';
import { mockPeople } from '../mock/people.js';

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
  /** open | escalated | resolved | rejected. */
  status: string;
  /** The initiative it was raised against, or null for an org-wide call. */
  projectId: string | null;
  decidedAt: string | null;
  participantCount: number;
}

export interface DecisionDetail {
  id: string;
  topic: string;
  summary: string | null;
  status: string;
  projectId: string | null;
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

// ─── Mock path (config.mock.aurora) ──────────────────────────────────────────
//
// Mirrors the two SQL statements below rather than hand-writing their answers:
// the same ordering, the same `since` filter, and participantCount COUNTED
// from the participant rows instead of stored beside the decision.

/**
 * `COALESCE(d.decided_at, d.created_at)` — the expression the SQL orders and
 * filters on. Both seeds leave `created_at` to its `NOW()` default, so a
 * decision that has not been decided yet sorts and filters as today: an open
 * call is the most recent thing that happened to it. Reading `decidedAt ?? ''`
 * instead put every open decision at the BOTTOM of a list Aurora puts them at
 * the top of, which is the same fixture disagreeing with the query it mirrors.
 */
const SEEDED_AT = new Date().toISOString().slice(0, 10);
const activityDate = (d: { decidedAt: string | null }): string => d.decidedAt ?? SEEDED_AT;

function mockListDecisions(limit: number, since?: string): DecisionSummary[] {
  const counts = countBy(decisionParticipantRows.rows(), 'decisionId');
  return decisionRows
    .rows()
    // WHERE d.decided_at >= :since OR (d.decided_at IS NULL AND d.created_at >= :since)
    .filter((d) => !since || activityDate(d) >= since)
    .slice()
    // ORDER BY COALESCE(decided_at, created_at) DESC NULLS LAST
    .sort((a, b) => activityDate(b).localeCompare(activityDate(a)))
    .slice(0, limit)
    .map((d) => ({
      id: d.id,
      topic: d.topic,
      summary: d.summary,
      status: d.status,
      projectId: d.projectId,
      decidedAt: d.decidedAt,
      participantCount: counts.get(d.id) ?? 0,
    }));
}

function mockGetDecision(id: string): DecisionDetail | null {
  const head = decisionRows.rows().find((d) => d.id === id);
  if (!head) return null;
  const byId = new Map(mockPeople.map((p) => [p.id, p]));
  return {
    id: head.id,
    topic: head.topic,
    summary: head.summary,
    status: head.status,
    projectId: head.projectId,
    decidedAt: head.decidedAt,
    participants: decisionParticipantRows
      .rows()
      .filter((p) => p.decisionId === id)
      // The SQL JOINs `people`, so a participant with no person row is dropped
      // rather than rendered as a nameless id.
      .flatMap((p) => {
        const person = byId.get(p.personId);
        return person
          ? [{ personId: p.personId, name: person.name, title: person.title, role: p.role, weight: p.weight }]
          : [];
      })
      // ORDER BY dp.weight DESC NULLS LAST, p.name
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)),
  };
}

export async function listDecisions(
  opts: { limit?: number; since?: string } = {},
): Promise<DecisionSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (config.mock.aurora) return mockListDecisions(limit, opts.since);

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
      d.status,
      d.project_id,
      d.decided_at,
      COUNT(dp.person_id)::int AS participant_count
    FROM decisions d
    LEFT JOIN decision_participants dp ON dp.decision_id = d.id
    WHERE 1=1
    ${sinceClause}
    GROUP BY d.id, d.topic, d.summary, d.status, d.project_id, d.decided_at
    ORDER BY COALESCE(d.decided_at, d.created_at) DESC NULLS LAST
    LIMIT :lim
  `;

  const rows = await exec(sql, params);
  return rows.map((r) => ({
    id: String(r['id']),
    topic: String(r['topic'] ?? ''),
    summary: r['summary'] != null ? String(r['summary']) : null,
    status: String(r['status'] ?? 'open'),
    projectId: r['project_id'] != null ? String(r['project_id']) : null,
    decidedAt: r['decided_at'] != null ? String(r['decided_at']) : null,
    participantCount: typeof r['participant_count'] === 'number' ? r['participant_count'] : 0,
  }));
}

export async function getDecision(id: string): Promise<DecisionDetail | null> {
  if (config.mock.aurora) return mockGetDecision(id);

  const headRows = await exec(
    `SELECT id, topic, summary, status, project_id, decided_at FROM decisions WHERE id = :id LIMIT 1`,
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
    status: String(head['status'] ?? 'open'),
    projectId: head['project_id'] != null ? String(head['project_id']) : null,
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

// ─── Work-graph read (lib/work-graph/sources.ts) ─────────────────────────────
//
// The activity graph draws a decision only on an honest instant of its own:
// `decided_at` (a DATE — the whole calendar day) or `escalated_at` (a
// timestamp). An open decision with neither has no moment to draw, and
// `created_at` is not it (the seeds leave it to its NOW() default), so such a
// row is not returned here. Same table, same rows as listDecisions /
// getDecision / getProjectDecisions — one concept, one more projection.

export interface DecisionActivityRow {
  id: string;
  topic: string;
  summary: string | null;
  status: string;
  projectId: string | null;
  workItemId: string | null;
  requiredRole: string | null;
  /** 'YYYY-MM-DD' (a DATE), or null. */
  decidedAt: string | null;
  /** ISO timestamp, or null. */
  escalatedAt: string | null;
  participants: Array<{ personId: string; name: string; role: string | null }>;
}

export const DECISION_ACTIVITY_LIMIT = 200;

export async function listDecisionActivity(opts: { projectId?: string } = {}): Promise<DecisionActivityRow[]> {
  if (config.mock.aurora) {
    const byId = new Map(mockPeople.map((p) => [p.id, p]));
    return decisionRows.rows()
      .filter((d) => (d.decidedAt || d.escalatedAt) && (!opts.projectId || d.projectId === opts.projectId))
      .map((d) => ({
        id: d.id, topic: d.topic, summary: d.summary, status: d.status, projectId: d.projectId, workItemId: d.workItemId,
        requiredRole: d.requiredRole, decidedAt: d.decidedAt, escalatedAt: d.escalatedAt,
        participants: decisionParticipantRows.rows().filter((p) => p.decisionId === d.id)
          .flatMap((p) => { const person = byId.get(p.personId); return person ? [{ personId: p.personId, name: person.name, role: p.role }] : []; }),
      }))
      .sort((a, b) => (b.escalatedAt ?? b.decidedAt ?? '').localeCompare(a.escalatedAt ?? a.decidedAt ?? ''))
      .slice(0, DECISION_ACTIVITY_LIMIT);
  }
  const params = [intParam('lim', DECISION_ACTIVITY_LIMIT)];
  let projectClause = '';
  if (opts.projectId) { projectClause = 'AND d.project_id = :pid'; params.push(strParam('pid', opts.projectId)); }
  const heads = await exec(
    `SELECT d.id, d.topic, d.summary, d.status, d.project_id, d.work_item_id, d.required_role,
            d.decided_at::text AS decided_at, d.escalated_at
       FROM decisions d
      WHERE (d.decided_at IS NOT NULL OR d.escalated_at IS NOT NULL) ${projectClause}
      ORDER BY COALESCE(d.escalated_at, d.decided_at) DESC
      LIMIT :lim`,
    params,
  );
  if (heads.length === 0) return [];
  const names = heads.map((_, i) => `:d${i}`).join(', ');
  const people = await exec(
    `SELECT dp.decision_id, dp.person_id, p.name, dp.role
       FROM decision_participants dp JOIN people p ON p.id = dp.person_id
      WHERE dp.decision_id IN (${names})
      ORDER BY dp.weight DESC NULLS LAST, p.name`,
    heads.map((h, i) => strParam(`d${i}`, String(h['id']))),
  );
  const mine = new Map<string, DecisionActivityRow['participants']>();
  for (const r of people) {
    const list = mine.get(String(r['decision_id'])) ?? [];
    list.push({ personId: String(r['person_id']), name: String(r['name'] ?? ''), role: r['role'] != null ? String(r['role']) : null });
    mine.set(String(r['decision_id']), list);
  }
  return heads.map((r) => ({
    id: String(r['id']), topic: String(r['topic'] ?? ''), summary: r['summary'] != null ? String(r['summary']) : null,
    status: String(r['status'] ?? 'open'), projectId: r['project_id'] != null ? String(r['project_id']) : null,
    workItemId: r['work_item_id'] != null ? String(r['work_item_id']) : null,
    requiredRole: r['required_role'] != null ? String(r['required_role']) : null,
    decidedAt: r['decided_at'] != null ? String(r['decided_at']).slice(0, 10) : null,
    escalatedAt: r['escalated_at'] != null ? String(r['escalated_at']) : null,
    participants: mine.get(String(r['id'])) ?? [],
  }));
}
