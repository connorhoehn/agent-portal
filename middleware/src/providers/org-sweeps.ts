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

// ── Remediation ──────────────────────────────────────────────────────────────
//
// What a worker should actually DO about a finding depends on what was found:
// a skill with one holder needs a cross-training plan, an unlinked document
// needs an extraction diagnosis. These prompts used to be built in the browser
// — one generic string for every sweep — which put the agent's instructions in
// the least authoritative place in the system and meant a new sweep could not
// carry its own remedy. They live with the sweep that produces the finding.
//
// The worker is Claude Code in a microVM: it has /mnt/workspace and git, and
// NO database access. So every prompt must carry the evidence it needs inline
// and ask for an artifact the worker can actually produce. Asking it to "fix
// the graph" would be asking for something it cannot reach — graph changes go
// through the proposal path, where a human approves them.

export interface Remediation {
  prompt: string;
  /** Lower runs sooner. Criticals jump the queue. */
  priority: number;
}

/** Deterministic, filesystem-safe slug so re-runs update a file, not fork it. */
function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';
}

const COMMIT_RULE =
  'Write the file, then commit it with git (a short, specific message). ' +
  'If the file already exists and already covers this, say so plainly and do NOT ' +
  'duplicate it — report that no action was needed instead.';

function busFactorRemedy(f: Finding): Remediation {
  const ev = f.evidence as { holders?: number; holderNames?: string[] };
  const holders = ev.holders ?? 0;
  const names = (ev.holderNames ?? []).join(', ') || 'unknown';
  return {
    priority: holders <= 1 ? 10 : 40,
    prompt:
      `An organizational sweep found a skill coverage risk.\n\n` +
      `Skill risk: ${f.title}\n` +
      `Current holders (${holders}): ${names}\n\n` +
      `Write \`coverage/${slug(f.title)}.md\` containing:\n` +
      `  1. Why ${holders} holder${holders === 1 ? '' : 's'} is a risk for this specific skill.\n` +
      `  2. What work would stall if they were unavailable.\n` +
      `  3. Three concrete cross-training steps, each with a named first action.\n` +
      `  4. How the org would know the risk is retired.\n\n` +
      `Be specific and short — this is read by an engineering leader, not scored ` +
      `by a rubric. ${COMMIT_RULE}`,
  };
}

function staleDocRemedy(f: Finding): Remediation {
  const ev = f.evidence as { source?: string; ingestedAt?: string };
  return {
    priority: 60,
    prompt:
      `An organizational sweep found an indexed document that nothing references.\n\n` +
      `Document: ${f.title}\n` +
      `Source: ${ev.source ?? 'unknown'} · ingested ${ev.ingestedAt ?? 'unknown'}\n\n` +
      `No person, project, or decision links to it, which means entity extraction ` +
      `either missed it or the knowledge is genuinely orphaned.\n\n` +
      `Write \`linking/${slug(f.title)}.md\` containing:\n` +
      `  1. The most likely reason extraction produced no mentions for a document ` +
      `of this kind and source.\n` +
      `  2. Which entity types SHOULD have matched, and what surface forms would ` +
      `have to be recognised for that to happen.\n` +
      `  3. Whether this is worth fixing for one document or points at a class of ` +
      `documents — say which, and why.\n\n` +
      `${COMMIT_RULE}`,
  };
}

function orphanDecisionRemedy(f: Finding): Remediation {
  const ev = f.evidence as { decidedAt?: string };
  return {
    priority: 30,
    prompt:
      `An organizational sweep found a decision with no participants recorded.\n\n` +
      `Decision: ${f.title}\n` +
      `Decided: ${ev.decidedAt ?? 'unknown'}\n\n` +
      `Nobody owns it, so "who decided this?" has no answer and no one is ` +
      `accountable for revisiting it.\n\n` +
      `Write \`decisions/${slug(f.title)}.md\` containing:\n` +
      `  1. What evidence would establish ownership of a decision like this.\n` +
      `  2. The questions to ask, and who to ask them of.\n` +
      `  3. What should change in the ingestion path so future decisions arrive ` +
      `with participants attached.\n\n` +
      `${COMMIT_RULE}`,
  };
}

const REMEDIES: Record<SweepName, (f: Finding) => Remediation> = {
  bus_factor: busFactorRemedy,
  stale_docs: staleDocRemedy,
  orphan_decisions: orphanDecisionRemedy,
};

/**
 * How to act on a finding. Falls back to a generic investigation for findings
 * from a sweep that has not declared a remedy — a new sweep should still be
 * promotable on the day it ships.
 */
export function remediationFor(f: Finding): Remediation {
  const build = REMEDIES[f.sweep as SweepName];
  if (build) return build(f);
  return {
    priority: f.severity === 'critical' ? 10 : f.severity === 'warning' ? 40 : 70,
    prompt:
      `An organizational sweep produced a finding that needs a human-readable ` +
      `assessment.\n\nFinding: ${f.title}\nDetail: ${f.detail ?? '(none)'}\n` +
      `Evidence: ${JSON.stringify(f.evidence)}\n\n` +
      `Write \`findings/${slug(f.title)}.md\` assessing what is actually wrong, ` +
      `how much it matters, and the first concrete step. ${COMMIT_RULE}`,
  };
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

  // One multi-row upsert instead of a write per finding (N+1 on a scheduled
  // interval). Each draft gets its own positional parameter set (:sev_0, …);
  // sweep is shared across every row. RETURNING (xmax = 0) still distinguishes
  // an inserted row from an updated one per row, so created/updated stay exact.
  // Fingerprints are unique within a sweep (entity id per row), so no row is
  // touched twice in one statement.
  if (drafts.length > 0) {
    const valueClauses: string[] = [];
    const params: SqlParameter[] = [s('sweep', name)];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      valueClauses.push(
        `(:sweep, :sev_${i}, :title_${i}, :detail_${i}, :etype_${i}, :eid_${i}, :evidence_${i}::jsonb, :fp_${i})`,
      );
      params.push(
        s(`sev_${i}`, d.severity), s(`title_${i}`, d.title), s(`detail_${i}`, d.detail),
        s(`etype_${i}`, d.entityType), s(`eid_${i}`, d.entityId),
        s(`evidence_${i}`, JSON.stringify(d.evidence)), s(`fp_${i}`, d.fingerprint),
      );
    }
    const rows = await exec(
      `INSERT INTO agent_findings
         (sweep, severity, title, detail, entity_type, entity_id, evidence, fingerprint)
       VALUES ${valueClauses.join(', ')}
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
      params,
    );
    for (const r of rows) {
      if (r['inserted'] === true) created++; else updated++;
    }
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

/**
 * Put findings back on the board when the work sent after them died.
 *
 * The per-run hooks (cancel, reject) cover the cases a human triggers, but a
 * job can also end unproductively on its own — failed on the agent side, or
 * failed by the reaper after exhausting attempts. The upsert in runSweep only
 * reopens 'resolved' findings, so without this a 'promoted' finding pinned to
 * a dead job is stuck forever: the problem still reproduces every sweep, and
 * the board silently never mentions it again. Sweeping this before each run
 * makes the loop self-healing no matter how the job died.
 */
export async function releaseAbandonedFindings(): Promise<number> {
  if (config.mock.aurora) return 0;
  const rows = await exec(
    `UPDATE agent_findings f
        SET status = 'open', job_id = NULL
       FROM agent_jobs j
      WHERE f.job_id = j.id
        AND f.status = 'promoted'
        AND j.status IN ('cancelled', 'failed')
      RETURNING f.id`,
  );
  return rows.length;
}

export interface SweepRunReport {
  results: Array<Awaited<ReturnType<typeof runSweep>>>;
  /** Findings put back on the board because their worker never delivered. */
  released: number;
}

export async function runAllSweeps(): Promise<SweepRunReport> {
  const released = await releaseAbandonedFindings().catch(() => 0);
  const out: Array<Awaited<ReturnType<typeof runSweep>>> = [];
  for (const name of SWEEP_NAMES) {
    try {
      out.push(await runSweep(name));
    } catch (err) {
      console.warn(`[sweeps] ${name} failed:`, (err as Error).message);
    }
  }
  return { results: out, released };
}

// ── Lab signals — findings filed by computer-lab agents ─────────────────────
//
// A lab session that notices something outside its task files it HERE, as a
// finding with sweep='lab-signal' — not into some parallel inbox. Everything
// downstream (the Work page list, the open/critical counts, promote → job,
// abandoned-job release) applies to a lab signal for free, because it is not
// a new kind of thing; it is a finding from a new source.
//
// Mock mode gets a real in-memory store (unlike the scheduled sweeps, which
// read Aurora and honestly no-op without it): the whole point of a signal is
// an agent ASSERTING it, and that works fine against memory in dev:mock.

export const LAB_SWEEP = 'lab-signal';

const MOCK_FINDINGS: Finding[] = [];
let mockFindingSeq = 0;

export interface LabSignalInput {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail?: string;
  /** Stable identity: refiling the same issue updates last_seen, not a dup. */
  fingerprint: string;
  sessionId?: string;
  boxId?: string;
  repo?: string;
  initiativeId?: string;
}

export async function fileLabSignal(input: LabSignalInput): Promise<Finding> {
  const evidence: Record<string, unknown> = {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.boxId ? { boxId: input.boxId } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}),
  };
  const now = new Date().toISOString();

  if (config.mock.aurora) {
    const existing = MOCK_FINDINGS.find(
      (f) => f.sweep === LAB_SWEEP && f.fingerprint === input.fingerprint,
    );
    if (existing) {
      existing.severity = input.severity;
      existing.title = input.title;
      existing.detail = input.detail ?? existing.detail;
      existing.evidence = { ...existing.evidence, ...evidence };
      existing.lastSeenAt = now;
      if (existing.status === 'resolved') existing.status = 'open';
      return existing;
    }
    const finding: Finding = {
      id: `find-mock-${++mockFindingSeq}`,
      sweep: LAB_SWEEP,
      severity: input.severity,
      title: input.title,
      detail: input.detail ?? null,
      entityType: input.repo ? 'repo' : null,
      entityId: input.repo ?? null,
      evidence,
      status: 'open',
      jobId: null,
      firstSeenAt: now,
      lastSeenAt: now,
      fingerprint: input.fingerprint,
    };
    MOCK_FINDINGS.push(finding);
    return finding;
  }

  const rows = await exec(
    `INSERT INTO agent_findings (sweep, severity, title, detail, entity_type, entity_id, evidence, fingerprint)
     VALUES (:sweep, :sev, :title, :detail, :etype, :eid, :evidence::jsonb, :fp)
     ON CONFLICT (sweep, fingerprint) DO UPDATE
        SET severity = EXCLUDED.severity,
            title = EXCLUDED.title,
            detail = EXCLUDED.detail,
            evidence = agent_findings.evidence || EXCLUDED.evidence,
            last_seen_at = NOW(),
            status = CASE WHEN agent_findings.status = 'resolved' THEN 'open' ELSE agent_findings.status END
     RETURNING id`,
    [
      s('sweep', LAB_SWEEP), s('sev', input.severity), s('title', input.title),
      s('detail', input.detail ?? ''), s('etype', input.repo ? 'repo' : ''),
      s('eid', input.repo ?? ''), s('evidence', JSON.stringify(evidence)),
      s('fp', input.fingerprint),
    ],
  );
  const filed = await getFinding(toStr(rows[0]?.['id']));
  if (!filed) throw new Error('lab signal insert returned no row');
  return filed;
}

export async function listFindings(opts: { status?: string; sweep?: string; limit?: number } = {}): Promise<Finding[]> {
  if (config.mock.aurora) {
    const sevRank = { critical: 0, warning: 1, info: 2 } as const;
    return MOCK_FINDINGS
      .filter((f) => (!opts.status || f.status === opts.status) && (!opts.sweep || f.sweep === opts.sweep))
      .sort((a, b) =>
        (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3) ||
        b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, Math.min(Math.max(opts.limit ?? 100, 1), 300));
  }
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

/** One finding by id, or null. */
export async function getFinding(id: string): Promise<Finding | null> {
  if (config.mock.aurora) return MOCK_FINDINGS.find((f) => f.id === id) ?? null;
  const rows = await exec(
    `SELECT id, sweep, severity, title, detail, entity_type, entity_id,
            evidence::text AS evidence, status, job_id,
            first_seen_at::text AS first_seen_at, last_seen_at::text AS last_seen_at, fingerprint
       FROM agent_findings WHERE id = :id`,
    [s('id', id)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
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
  };
}

/** Counts by sweep and status — drives the grouped findings UI. */
export async function findingStats(): Promise<Array<{ sweep: string; status: string; severity: string; n: number }>> {
  if (config.mock.aurora) return [];
  const rows = await exec(
    `SELECT sweep, status, severity, count(*)::int AS n
       FROM agent_findings GROUP BY sweep, status, severity`,
  );
  return rows.map((r) => ({
    sweep: toStr(r['sweep']),
    status: toStr(r['status']),
    severity: toStr(r['severity']),
    n: Number(r['n'] ?? 0),
  }));
}

/**
 * Release a finding whose job never produced anything.
 *
 * Promoting sets the finding to 'promoted' and pins it to a job. If that job
 * is then cancelled or its output rejected, the underlying problem is still
 * there — but the finding would sit in 'promoted' forever, pointing at work
 * that never landed, and the next sweep would skip re-opening it because
 * 'promoted' is not 'resolved'. That is how a real finding goes quiet without
 * anyone deciding it should.
 */
export async function reopenFindingForJob(jobId: string): Promise<number> {
  if (config.mock.aurora) return 0;
  const rows = await exec(
    `UPDATE agent_findings
        SET status = 'open', job_id = NULL
      WHERE job_id = :job AND status = 'promoted'
      RETURNING id`,
    [s('job', jobId)],
  );
  return rows.length;
}

export async function setFindingStatus(id: string, status: 'open' | 'dismissed' | 'promoted' | 'resolved', jobId?: string): Promise<boolean> {
  if (config.mock.aurora) {
    const f = MOCK_FINDINGS.find((x) => x.id === id);
    if (!f) return false;
    f.status = status;
    if (jobId) f.jobId = jobId;
    return true;
  }
  const rows = await exec(
    `UPDATE agent_findings
        SET status = :status, job_id = COALESCE(NULLIF(:job, ''), job_id)
      WHERE id = :id RETURNING id`,
    [s('id', id), s('status', status), s('job', jobId ?? '')],
  );
  return rows.length > 0;
}
