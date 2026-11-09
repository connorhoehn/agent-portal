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
import { exec, fetchAvatarsById, withTransaction } from './aurora.js';
import { mockAvatarUrl } from '../mock/avatars.js';
import { clock, countBy } from '../mock/core/index.js';
import { decisionRows, decisionParticipantRows, decisionEventRows, type DecisionOption } from '../mock/decisions.js';

export type { DecisionOption } from '../mock/decisions.js';
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
  /** When it was decided: an ISO instant, or a 'YYYY-MM-DD' day where only the DATE is known; null while it waits. */
  decidedAt: string | null;
  /** What was decided, one sentence or a short paragraph (the `resolution` column); null while it waits. */
  outcome: string | null;
  participantCount: number;
}

/**
 * One entry of a decision's recorded history (`decision_events`, G54): the
 * call someone made on the page or by voice, who made it, when and why.
 */
export interface DecisionEvent {
  id: string;
  kind: 'resolved' | 'rejected';
  /** ISO timestamp. */
  at: string;
  by: { id: string; name: string };
  rationale: string;
}

export interface DecisionDetail {
  id: string;
  topic: string;
  summary: string | null;
  status: string;
  projectId: string | null;
  decidedAt: string | null;
  /** Who made the call (G54, `decided_by`, a person id or an account subject), or null while it waits. */
  decidedBy: { id: string; name: string } | null;
  /** What was decided (the `resolution` column, written by the decide route as the decider's rationale), or null. */
  outcome: string | null;
  /** The recorded history, newest first. Empty until someone decides it here. */
  history: DecisionEvent[];
  /**
   * G57: the pre-canned answers it offers (the `options` jsonb column), in
   * order; the record page numbers them and `POST /:id/decide { optionId }`
   * records the chosen label. Empty for a settled seed row.
   */
  options: DecisionOption[];
  participants: Array<{
    personId: string;
    avatarUrl: string | null;
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
      outcome: d.resolution ?? null,
      participantCount: counts.get(d.id) ?? 0,
    }));
}

function mockGetDecision(id: string): DecisionDetail | null {
  const head = decisionRows.rows().find((d) => d.id === id);
  if (!head) return null;
  const byId = new Map(mockPeople.map((p) => [p.id, p]));
  const history = decisionEventRows.rows()
    .filter((e) => e.decisionId === id)
    .map((e) => ({ id: e.id, kind: e.kind, at: e.at, by: { id: e.actorId, name: e.actorName }, rationale: e.rationale }))
    // ORDER BY at DESC
    .sort((a, b) => b.at.localeCompare(a.at));
  const by = head.decidedBy ?? null;
  return {
    id: head.id,
    topic: head.topic,
    summary: head.summary,
    status: head.status,
    projectId: head.projectId,
    decidedAt: head.decidedAt,
    // LEFT JOIN people on decided_by, falling back to the name the event recorded (an unlinked account).
    decidedBy: by ? { id: by, name: byId.get(by)?.name ?? history.find((e) => e.by.id === by)?.by.name ?? by } : null,
    outcome: head.resolution ?? null,
    history,
    options: (head.options ?? []).map((o) => ({ ...o })),
    participants: decisionParticipantRows
      .rows()
      .filter((p) => p.decisionId === id)
      // The SQL JOINs `people`, so a participant with no person row is dropped
      // rather than rendered as a nameless id.
      .flatMap((p) => {
        const person = byId.get(p.personId);
        return person
          ? [{ personId: p.personId, avatarUrl: mockAvatarUrl(p.personId), name: person.name, title: person.title, role: p.role, weight: p.weight }]
          : [];
      })
      // ORDER BY dp.weight DESC NULLS LAST, p.name
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)),
  };
}

/**
 * When a decision was made, as the list and the record read it: the instant
 * (`resolved_at`, set by every decide and by the seeds) as an ISO string,
 * else the DATE column's day. A day alone is ambiguous across zones; the
 * portal reads one as that day and never as a time still to come.
 */
const DECIDED_INSTANT = `COALESCE(to_char(d.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), d.decided_at::text)`;

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
      ${DECIDED_INSTANT} AS decided_at,
      d.resolution,
      COUNT(dp.person_id)::int AS participant_count
    FROM decisions d
    LEFT JOIN decision_participants dp ON dp.decision_id = d.id
    WHERE 1=1
    ${sinceClause}
    GROUP BY d.id, d.topic, d.summary, d.status, d.project_id, d.decided_at, d.resolved_at, d.resolution
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
    outcome: r['resolution'] != null ? String(r['resolution']) : null,
    participantCount: typeof r['participant_count'] === 'number' ? r['participant_count'] : 0,
  }));
}

export async function getDecision(id: string): Promise<DecisionDetail | null> {
  if (config.mock.aurora) return mockGetDecision(id);

  const headRows = await exec(
    `SELECT d.id, d.topic, d.summary, d.status, d.project_id, ${DECIDED_INSTANT} AS decided_at, d.resolution, d.decided_by,
            d.options::text AS options,
            COALESCE(p.name, d.decided_by) AS decided_by_name
       FROM decisions d LEFT JOIN people p ON p.id = d.decided_by
      WHERE d.id = :id LIMIT 1`,
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

  const eventRows = await exec(
    `SELECT id::text AS id, kind, at, actor_id, actor_name, rationale
       FROM decision_events WHERE decision_id = :id ORDER BY at DESC`,
    [strParam('id', id)],
  );

  const avatars = await fetchAvatarsById(partRows.map(row => String(row['person_id'])));
  return {
    id: String(head['id']),
    topic: String(head['topic'] ?? ''),
    summary: head['summary'] != null ? String(head['summary']) : null,
    status: String(head['status'] ?? 'open'),
    projectId: head['project_id'] != null ? String(head['project_id']) : null,
    decidedAt: head['decided_at'] != null ? String(head['decided_at']) : null,
    decidedBy: head['decided_by'] != null
      ? { id: String(head['decided_by']), name: String(head['decided_by_name'] ?? head['decided_by']) }
      : null,
    outcome: head['resolution'] != null ? String(head['resolution']) : null,
    history: eventRows.map((r) => ({
      id: String(r['id']),
      kind: String(r['kind']) === 'rejected' ? 'rejected' as const : 'resolved' as const,
      at: String(r['at']),
      by: { id: String(r['actor_id'] ?? ''), name: String(r['actor_name'] ?? r['actor_id'] ?? '') },
      rationale: String(r['rationale'] ?? ''),
    })),
    options: parseDecisionOptions(head['options']),
    participants: partRows.map((r) => ({
      personId: String(r['person_id']),
      avatarUrl: avatars.get(String(r['person_id'])) ?? null,
      name: String(r['name'] ?? ''),
      title: r['title'] != null ? String(r['title']) : null,
      role: r['role'] != null ? String(r['role']) : null,
      weight: typeof r['weight'] === 'number' ? r['weight'] : 1.0,
    })),
  };
}

/**
 * The `options` jsonb column as the record's options (G57): an array of
 * `{ id, label, detail? }`, read through `::text` (the Data API hands jsonb
 * back as a string). Anything malformed is dropped, never invented: a row
 * with no usable options offers none.
 */
export function parseDecisionOptions(raw: unknown): DecisionOption[] {
  let value: unknown = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(value)) return [];
  return value.flatMap((o): DecisionOption[] => {
    if (!o || typeof o !== 'object') return [];
    const { id, label, detail } = o as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || typeof label !== 'string' || !label.trim()) return [];
    return [{ id: id.trim(), label: label.trim(), ...(typeof detail === 'string' && detail.trim() ? { detail: detail.trim() } : {}) }];
  });
}

// ─── Deciding (G54) ─────────────────────────────────────────────────────────
//
// The one write on this table from the product: a waiting decision (open or
// escalated) is resolved or rejected, with the decider's rationale as its
// outcome. It sets `status`, `decided_at` (the day), `resolved_at` (the
// instant, which the reads serve as `decidedAt`), `decided_by` and
// `resolution`, and appends a `decision_events`
// row, the history the record page reads. Who may call it is the route's
// question (routes/decisions.ts); this only refuses a row that is not waiting.

export const DECISION_OUTCOMES = ['resolved', 'rejected'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export const WAITING_STATUSES: readonly string[] = ['open', 'escalated'];

export interface DecideInput {
  outcome: DecisionOutcome;
  rationale: string;
  /** The person id the decider acts under, else their account subject. */
  actorId: string;
  actorName: string;
}

export type DecideResult =
  | { kind: 'ok'; decision: DecisionDetail }
  | { kind: 'not-found' }
  | { kind: 'settled'; status: string };

export async function decideDecision(id: string, input: DecideInput): Promise<DecideResult> {
  if (config.mock.aurora) {
    const row = decisionRows.rows().find((d) => d.id === id);
    if (!row) return { kind: 'not-found' };
    if (!WAITING_STATUSES.includes(row.status)) return { kind: 'settled', status: row.status };
    const at = clock.nowIso();
    row.status = input.outcome;
    // The instant, not the day: a date-only value read as noon UTC once
    // printed "Decided in 8h" (walk, 9 November). Aurora keeps the day in
    // `decided_at` and the instant in `resolved_at`; reads serve the instant.
    row.decidedAt = at;
    row.resolvedAt = at;
    row.decidedBy = input.actorId;
    row.resolution = input.rationale;
    const events = decisionEventRows.rows();
    events.push({
      id: `de-${events.length + 1}`, decisionId: id, kind: input.outcome, at,
      actorId: input.actorId, actorName: input.actorName, rationale: input.rationale,
    });
    const decision = mockGetDecision(id);
    return decision ? { kind: 'ok', decision } : { kind: 'not-found' };
  }

  // The guarded UPDATE is the race check: two deciders at once, one wins and
  // the other reads the settled status below.
  const updated = await withTransaction(async (tx) => {
    const rows = await tx(
      `UPDATE decisions
          SET status = :outcome, decided_at = CURRENT_DATE, resolved_at = NOW(),
              resolution = :rationale, decided_by = :actor
        WHERE id = :id AND status IN ('open', 'escalated')
        RETURNING id`,
      [strParam('outcome', input.outcome), strParam('rationale', input.rationale), strParam('actor', input.actorId), strParam('id', id)],
    );
    if (rows.length === 0) return false;
    await tx(
      `INSERT INTO decision_events (decision_id, kind, actor_id, actor_name, rationale)
       VALUES (:id, :outcome, :actor, :name, :rationale)`,
      [strParam('id', id), strParam('outcome', input.outcome), strParam('actor', input.actorId), strParam('name', input.actorName), strParam('rationale', input.rationale)],
    );
    return true;
  });
  if (!updated) {
    const now = await exec(`SELECT status FROM decisions WHERE id = :id LIMIT 1`, [strParam('id', id)]);
    return now.length === 0 ? { kind: 'not-found' } : { kind: 'settled', status: String(now[0]!['status'] ?? '') };
  }
  const decision = await getDecision(id);
  return decision ? { kind: 'ok', decision } : { kind: 'not-found' };
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
  participants: Array<{ personId: string; name: string; role: string | null; avatarUrl?: string | null }>;
}

export const DECISION_ACTIVITY_LIMIT = 200;

export async function listDecisionActivity(opts: { projectId?: string } = {}): Promise<DecisionActivityRow[]> {
  if (config.mock.aurora) {
    const byId = new Map(mockPeople.map((p) => [p.id, p]));
    return decisionRows.rows()
      .filter((d) => (d.decidedAt || d.escalatedAt) && (!opts.projectId || d.projectId === opts.projectId))
      .map((d) => ({
        id: d.id, topic: d.topic, summary: d.summary, status: d.status, projectId: d.projectId, workItemId: d.workItemId,
        requiredRole: d.requiredRole, decidedAt: d.decidedAt ? d.decidedAt.slice(0, 10) : null, escalatedAt: d.escalatedAt,
        participants: decisionParticipantRows.rows().filter((p) => p.decisionId === d.id)
          .flatMap((p) => { const person = byId.get(p.personId); return person ? [{ personId: p.personId, avatarUrl: mockAvatarUrl(p.personId), name: person.name, role: p.role }] : []; }),
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
  const portraits = await fetchAvatarsById([...new Set(people.map(person => String(person['person_id'])))]);
  for (const r of people) {
    const list = mine.get(String(r['decision_id'])) ?? [];
    list.push({ personId: String(r['person_id']), name: String(r['name'] ?? ''), role: r['role'] != null ? String(r['role']) : null, avatarUrl: portraits.get(String(r['person_id'])) ?? null });
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
