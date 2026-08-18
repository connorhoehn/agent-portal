// Scheduled org sweeps — the system noticing things without being asked.
//
// Each sweep is a pure read over live data that yields findings. Findings are
// upserted by (sweep, fingerprint) so re-running nightly updates last_seen_at
// instead of piling up duplicates — an operator's "open findings" list stays
// the same size when nothing changed, which is what makes it trustworthy.
//
// Sweeps deliberately do NOT act. They produce evidence; a human promotes a
// finding into the work queue, and the queue's output is reviewed before it
// touches the graph.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

export type SweepName = 'bus_factor' | 'stale_docs' | 'orphan_decisions';

export interface Finding {
  id: string;
  sweep: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string | null;
  entityType: string | null;
  entityId: string | null;
  evidence: Record<string, unknown>;
  status: string;
  jobId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  fingerprint: string;
}

interface DraftFinding {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  entityType: string;
  entityId: string;
  evidence: Record<string, unknown>;
  fingerprint: string;
}

function s(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}
function toStr(v: unknown, f = ''): string {
  return typeof v === 'string' ? v : v == null ? f : String(v);
}

// ── Sweep implementations ────────────────────────────────────────────────────

/**
 * Bus factor: skills held by very few people. A skill with one holder is a
 * single point of failure for the org; two is fragile. Uses the same signal
 * the Explore department strip surfaces, but org-wide and persisted.
 */
async function sweepBusFactor(): Promise<DraftFinding[]> {
  const rows = await exec(
    `SELECT s.id AS skill_id, s.name AS skill_name,
            count(ps.person_id)::int AS holders,
            string_agg(p.name, ', ' ORDER BY p.name) AS holder_names,
            string_agg(p.id,  ',' ORDER BY p.name)   AS holder_ids
       FROM skills s
       JOIN person_skills ps ON ps.skill_id = s.id
       JOIN people p         ON p.id = ps.person_id
      GROUP BY s.id, s.name
     HAVING count(ps.person_id) <= 2
      ORDER BY count(ps.person_id), s.name`,
  );
  return rows.map((r) => {
    const holders = Number(r['holders'] ?? 0);
    const skillName = toStr(r['skill_name']);
    return {
      severity: holders <= 1 ? ('critical' as const) : ('warning' as const),
      title: `${skillName}: ${holders} holder${holders === 1 ? '' : 's'} org-wide`,
      detail:
        holders <= 1
          ? `Only ${toStr(r['holder_names'])} holds ${skillName}. If they are unavailable the org has no coverage.`
          : `${skillName} is held by just ${toStr(r['holder_names'])}. One departure leaves a single point of failure.`,
      entityType: 'skill',
      entityId: toStr(r['skill_id']),
      evidence: {
        holders,
        holderNames: toStr(r['holder_names']).split(', ').filter(Boolean),
        holderIds: toStr(r['holder_ids']).split(',').filter(Boolean),
      },
      fingerprint: `skill:${toStr(r['skill_id'])}`,
    };
  });
}

/**
 * Stale docs: indexed documents nothing references. A document no person or
 * project mentions is either mis-ingested or genuinely orphaned knowledge —
 * both worth a human look before an agent cites it as authority.
 */
async function sweepStaleDocs(): Promise<DraftFinding[]> {
  const rows = await exec(
    `SELECT d.id, d.title, d.source, d.ingested_at::text AS ingested_at,
            (SELECT count(*) FROM mentions m WHERE m.document_id = d.id)::int AS mention_count
       FROM documents d
      WHERE NOT EXISTS (SELECT 1 FROM mentions m WHERE m.document_id = d.id)
      ORDER BY d.ingested_at DESC NULLS LAST
      LIMIT 50`,
  );
  return rows.map((r) => ({
    severity: 'info' as const,
    title: `Unlinked document: ${toStr(r['title'], '(untitled)')}`,
    detail:
      `This document is indexed but no person, project, or decision references it. ` +
      `Either entity extraction missed it or the knowledge is orphaned.`,
    entityType: 'document',
    entityId: toStr(r['id']),
    evidence: { source: toStr(r['source']), ingestedAt: toStr(r['ingested_at']), mentions: 0 },
    fingerprint: `doc:${toStr(r['id'])}`,
  }));
}

/**
 * Orphan decisions: decisions with no participants recorded. A decision
 * nobody owns cannot be followed up, and it silently degrades the graph's
 * usefulness for "who decided X?" questions.
 */
async function sweepOrphanDecisions(): Promise<DraftFinding[]> {
  const rows = await exec(
    `SELECT d.id, d.topic, d.decided_at::text AS decided_at
       FROM decisions d
      WHERE NOT EXISTS (SELECT 1 FROM decision_participants dp WHERE dp.decision_id = d.id)
      ORDER BY d.decided_at DESC NULLS LAST
      LIMIT 50`,
  );
  return rows.map((r) => ({
    severity: 'warning' as const,
    title: `Decision with no owner: ${toStr(r['topic'], '(untitled)')}`,
    detail:
      `No participants are recorded for this decision, so "who decided this?" has no answer ` +
      `and nobody is accountable for revisiting it.`,
    entityType: 'decision',
    entityId: toStr(r['id']),
    evidence: { decidedAt: toStr(r['decided_at']) },
    fingerprint: `decision:${toStr(r['id'])}`,
  }));
}

const SWEEPS: Record<SweepName, () => Promise<DraftFinding[]>> = {
  bus_factor: sweepBusFactor,
  stale_docs: sweepStaleDocs,
  orphan_decisions: sweepOrphanDecisions,
};

export const SWEEP_NAMES = Object.keys(SWEEPS) as SweepName[];

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Run a sweep and upsert its findings.
 *
 * Also resolves findings that no longer reproduce: if a skill gains a third
 * holder, last night's critical finding must stop shouting. Silence when the
 * problem is fixed is what earns the list a second look.
 */
export async function runSweep(name: SweepName): Promise<{
  sweep: SweepName; found: number; created: number; updated: number; resolved: number;
}> {
  if (config.mock.aurora) return { sweep: name, found: 0, created: 0, updated: 0, resolved: 0 };

  const drafts = await SWEEPS[name]();
  let created = 0;
  let updated = 0;

  for (const d of drafts) {
    const rows = await exec(
      `INSERT INTO agent_findings
         (sweep, severity, title, detail, entity_type, entity_id, evidence, fingerprint)
       VALUES (:sweep, :sev, :title, :detail, :etype, :eid, :evidence::jsonb, :fp)
       ON CONFLICT (sweep, fingerprint) DO UPDATE
         SET severity = EXCLUDED.severity,
             title    = EXCLUDED.title,
             detail   = EXCLUDED.detail,
             evidence = EXCLUDED.evidence,
             last_seen_at = NOW(),
             -- a finding that was resolved but reproduces is open again
             status = CASE WHEN agent_findings.status = 'resolved' THEN 'open'
                           ELSE agent_findings.status END
       RETURNING (xmax = 0) AS inserted`,
      [
        s('sweep', name), s('sev', d.severity), s('title', d.title), s('detail', d.detail),
        s('etype', d.entityType), s('eid', d.entityId),
        s('evidence', JSON.stringify(d.evidence)), s('fp', d.fingerprint),
      ],
    );
    if (rows[0]?.['inserted'] === true) created++; else updated++;
  }

  // Anything this sweep previously reported but did not see this run is fixed.
  // 'promoted' rows resolve too: work was queued for the finding and the
  // problem no longer reproduces, so the loop closed — leaving them open
  // would strand completed work in the list forever. 'dismissed' stays
  // dismissed; a human said they did not care.
  const fingerprints = drafts.map((d) => d.fingerprint);
  const resolvedRows = fingerprints.length
    ? await exec(
        `UPDATE agent_findings SET status='resolved'
          WHERE sweep = :sweep AND status IN ('open','promoted')
            AND fingerprint <> ALL (string_to_array(:fps, '|'))
          RETURNING id`,
        [s('sweep', name), s('fps', fingerprints.join('|'))],
      )
    : await exec(
        `UPDATE agent_findings SET status='resolved'
          WHERE sweep = :sweep AND status IN ('open','promoted') RETURNING id`,
        [s('sweep', name)],
      );

  return { sweep: name, found: drafts.length, created, updated, resolved: resolvedRows.length };
}

export async function runAllSweeps(): Promise<Array<Awaited<ReturnType<typeof runSweep>>>> {
  const out: Array<Awaited<ReturnType<typeof runSweep>>> = [];
  for (const name of SWEEP_NAMES) {
    try {
      out.push(await runSweep(name));
    } catch (err) {
      console.warn(`[sweeps] ${name} failed:`, (err as Error).message);
    }
  }
  return out;
}

export async function listFindings(opts: { status?: string; sweep?: string; limit?: number } = {}): Promise<Finding[]> {
  if (config.mock.aurora) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const where: string[] = [];
  const params: SqlParameter[] = [{ name: 'lim', value: { longValue: limit } }];
  if (opts.status) { where.push('status = :status'); params.push(s('status', opts.status)); }
  if (opts.sweep)  { where.push('sweep = :sweep');   params.push(s('sweep', opts.sweep)); }
  const rows = await exec(
    `SELECT id, sweep, severity, title, detail, entity_type, entity_id,
            evidence::text AS evidence, status, job_id,
            first_seen_at::text AS first_seen_at, last_seen_at::text AS last_seen_at, fingerprint
       FROM agent_findings
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               last_seen_at DESC
      LIMIT :lim`,
    params,
  );
  return rows.map((r) => ({
    id: toStr(r['id']),
    sweep: toStr(r['sweep']),
    severity: toStr(r['severity'], 'info') as Finding['severity'],
    title: toStr(r['title']),
    detail: r['detail'] ? toStr(r['detail']) : null,
    entityType: r['entity_type'] ? toStr(r['entity_type']) : null,
    entityId: r['entity_id'] ? toStr(r['entity_id']) : null,
    evidence: (() => { try { return JSON.parse(toStr(r['evidence'], '{}')) as Record<string, unknown>; } catch { return {}; } })(),
    status: toStr(r['status']),
    jobId: r['job_id'] ? toStr(r['job_id']) : null,
    firstSeenAt: toStr(r['first_seen_at']),
    lastSeenAt: toStr(r['last_seen_at']),
    fingerprint: toStr(r['fingerprint']),
  }));
}

export async function setFindingStatus(id: string, status: 'open' | 'dismissed' | 'promoted' | 'resolved', jobId?: string): Promise<boolean> {
  if (config.mock.aurora) return false;
  const rows = await exec(
    `UPDATE agent_findings
        SET status = :status, job_id = COALESCE(NULLIF(:job, ''), job_id)
      WHERE id = :id RETURNING id`,
    [s('id', id), s('status', status), s('job', jobId ?? '')],
  );
  return rows.length > 0;
}
