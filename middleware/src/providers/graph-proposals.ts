// Graph write-back — agent-proposed mutations, gated on human approval.
//
// Agents read the org graph constantly but were never allowed to improve it,
// so every correction required a human to hand-edit seed SQL. This closes the
// loop without handing an LLM write access to the source of truth:
//
//   agent/job proposes  →  pending  →  human approves  →  applier writes  →  applied
//                                   ↘  human rejects  →  rejected (kept for audit)
//
// Two deliberate constraints:
//   • Proposals are DECLARATIVE (kind + payload), never raw SQL, so a reviewer
//     reads data rather than auditing a query, and the applier is a small
//     closed switch that cannot be talked into arbitrary writes.
//   • Applying is idempotent (ON CONFLICT), so a retried approval cannot
//     double-write an edge or duplicate a skill.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

export type ProposalKind =
  | 'add_person_skill'      // payload: { personId, skillId, weight? }
  | 'update_person_title'   // payload: { personId, title }
  | 'add_collaboration'     // payload: { personAId, personBId, weight? }
  | 'add_skill'             // payload: { skillId, name, domain? }
  | 'link_document_mention'; // payload: { documentId, entityType, entityId }

export interface GraphProposal {
  id: string;
  source: string;
  jobId: string | null;
  findingId: string | null;
  kind: ProposalKind;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  rationale: string | null;
  evidence: Record<string, unknown>;
  confidence: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  reviewer: string | null;
  reviewNote: string | null;
  applyError: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toObj(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(toStr(v, '{}')) as Record<string, unknown>; } catch { return {}; }
}

const COLS = `id, source, job_id, finding_id, kind, target_type, target_id,
  payload::text AS payload, rationale, evidence::text AS evidence, confidence,
  status, reviewer, review_note, apply_error,
  created_at::text AS created_at, decided_at::text AS decided_at, applied_at::text AS applied_at`;

function rowToProposal(r: Record<string, unknown>): GraphProposal {
  return {
    id: toStr(r['id']),
    source: toStr(r['source']),
    jobId: r['job_id'] ? toStr(r['job_id']) : null,
    findingId: r['finding_id'] ? toStr(r['finding_id']) : null,
    kind: toStr(r['kind']) as ProposalKind,
    targetType: toStr(r['target_type']),
    targetId: toStr(r['target_id']),
    payload: toObj(r['payload']),
    rationale: r['rationale'] ? toStr(r['rationale']) : null,
    evidence: toObj(r['evidence']),
    confidence: r['confidence'] != null ? Number(r['confidence']) : null,
    status: toStr(r['status'], 'pending') as GraphProposal['status'],
    reviewer: r['reviewer'] ? toStr(r['reviewer']) : null,
    reviewNote: r['review_note'] ? toStr(r['review_note']) : null,
    applyError: r['apply_error'] ? toStr(r['apply_error']) : null,
    createdAt: toStr(r['created_at']),
    decidedAt: r['decided_at'] ? toStr(r['decided_at']) : null,
    appliedAt: r['applied_at'] ? toStr(r['applied_at']) : null,
  };
}

export async function proposeGraphChange(input: {
  source: string;
  kind: ProposalKind;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  rationale?: string;
  evidence?: Record<string, unknown>;
  confidence?: number;
  jobId?: string;
  findingId?: string;
}): Promise<GraphProposal | null> {
  if (config.mock.aurora) return null;
  // DO NOTHING against the live-dedupe index: proposing the same mutation
  // twice while an identical one is already pending/approved/applied is a
  // no-op, not a second row. Returns null in that case, which callers read as
  // "already known" rather than as a failure.
  const rows = await exec(
    `INSERT INTO graph_proposals
       (source, job_id, finding_id, kind, target_type, target_id, payload, rationale, evidence, confidence)
     VALUES (:source, NULLIF(:job,''), NULLIF(:finding,''), :kind, :ttype, :tid,
             :payload::jsonb, NULLIF(:rationale,''), :evidence::jsonb, :confidence)
     ON CONFLICT DO NOTHING
     RETURNING ${COLS}`,
    [
      s('source', input.source), s('job', input.jobId ?? ''), s('finding', input.findingId ?? ''),
      s('kind', input.kind), s('ttype', input.targetType), s('tid', input.targetId),
      s('payload', JSON.stringify(input.payload)),
      s('rationale', input.rationale ?? ''),
      s('evidence', JSON.stringify(input.evidence ?? {})),
      { name: 'confidence', value: input.confidence == null ? { isNull: true } : { doubleValue: input.confidence } },
    ],
  );
  return rows[0] ? rowToProposal(rows[0]) : null;
}

export async function listProposals(opts: { status?: string; limit?: number } = {}): Promise<GraphProposal[]> {
  if (config.mock.aurora) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const params: SqlParameter[] = [{ name: 'lim', value: { longValue: limit } }];
  let where = '';
  if (opts.status) { where = 'WHERE status = :status'; params.push(s('status', opts.status)); }
  const rows = await exec(
    `SELECT ${COLS} FROM graph_proposals ${where} ORDER BY created_at DESC LIMIT :lim`,
    params,
  );
  return rows.map(rowToProposal);
}

/**
 * Execute an approved proposal against the graph.
 *
 * Every branch is idempotent so re-applying is harmless, and every write is
 * scoped to one declarative mutation — there is no path from proposal payload
 * to arbitrary SQL.
 */
async function applyProposal(p: GraphProposal): Promise<void> {
  const pl = p.payload;
  switch (p.kind) {
    case 'add_person_skill': {
      const personId = toStr(pl['personId']);
      const skillId = toStr(pl['skillId']);
      if (!personId || !skillId) throw new Error('add_person_skill requires personId and skillId');
      await exec(
        `INSERT INTO person_skills (person_id, skill_id, weight)
         VALUES (:pid, :sid, :w)
         ON CONFLICT (person_id, skill_id) DO UPDATE SET weight = EXCLUDED.weight`,
        [s('pid', personId), s('sid', skillId),
         { name: 'w', value: { doubleValue: Number(pl['weight'] ?? 0.5) } }],
      );
      return;
    }
    case 'update_person_title': {
      const personId = toStr(pl['personId']);
      const title = toStr(pl['title']);
      if (!personId || !title) throw new Error('update_person_title requires personId and title');
      await exec(`UPDATE people SET title = :t, updated_at = NOW() WHERE id = :pid`,
        [s('pid', personId), s('t', title)]);
      return;
    }
    case 'add_collaboration': {
      // Collaborations are stored canonically (a < b) so the pair is unique
      // regardless of the order the proposer happened to observe them in.
      const a = toStr(pl['personAId']);
      const b = toStr(pl['personBId']);
      if (!a || !b || a === b) throw new Error('add_collaboration requires two distinct person ids');
      const [lo, hi] = a < b ? [a, b] : [b, a];
      await exec(
        `INSERT INTO collaborations (person_a_id, person_b_id, weight)
         VALUES (:a, :b, :w)
         ON CONFLICT (person_a_id, person_b_id) DO UPDATE SET weight = EXCLUDED.weight`,
        [s('a', lo), s('b', hi),
         { name: 'w', value: { doubleValue: Number(pl['weight'] ?? 0.5) } }],
      );
      return;
    }
    case 'add_skill': {
      const skillId = toStr(pl['skillId']);
      const name = toStr(pl['name']);
      if (!skillId || !name) throw new Error('add_skill requires skillId and name');
      await exec(
        `INSERT INTO skills (id, name, domain) VALUES (:id, :name, NULLIF(:domain,''))
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
        [s('id', skillId), s('name', name), s('domain', toStr(pl['domain']))],
      );
      return;
    }
    case 'link_document_mention': {
      const documentId = toStr(pl['documentId']);
      const entityType = toStr(pl['entityType']);
      const entityId = toStr(pl['entityId']);
      if (!documentId || !entityType || !entityId) {
        throw new Error('link_document_mention requires documentId, entityType and entityId');
      }
      // Only the node tables the graph actually has. An extractor that
      // hallucinated an entity type would otherwise write an unreferenceable
      // row — mentions has no FK on entity_id, so nothing else would catch it.
      if (!['person', 'skill', 'project', 'decision'].includes(entityType)) {
        throw new Error(`unsupported entity_type '${entityType}' for a mention`);
      }
      // DO NOTHING, not a count bump: applying the same approved proposal
      // twice must not inflate the mention weight.
      await exec(
        `INSERT INTO mentions (document_id, entity_type, entity_id, count)
         VALUES (:doc, :etype, :eid, 1)
         ON CONFLICT (document_id, entity_type, entity_id) DO NOTHING`,
        [s('doc', documentId), s('etype', entityType), s('eid', entityId)],
      );
      return;
    }
    default:
      throw new Error(`unsupported proposal kind: ${String(p.kind)}`);
  }
}

/** Approve (and immediately apply) or reject a pending proposal. */
/**
 * Approve (and apply) or reject a proposal.
 *
 * Acts on 'pending' AND 'failed' rows. A failed apply used to be terminal —
 * nothing could reject it off the board or retry it once its cause was fixed,
 * so a single bad row sat in the record forever with no way to resolve it.
 * Approving a failed proposal re-runs the apply; rejecting one clears it while
 * leaving the history (and its original apply_error) intact, because the point
 * of this table is to be auditable, not tidy.
 */
export async function decideProposal(
  id: string,
  decision: 'approve' | 'reject',
  opts: { reviewer?: string; note?: string } = {},
): Promise<GraphProposal | null> {
  if (config.mock.aurora) return null;

  const rows = await exec(
    `UPDATE graph_proposals
        SET status = :status, reviewer = NULLIF(:reviewer,''), review_note = NULLIF(:note,''), decided_at = NOW()
      WHERE id = :id AND status IN ('pending', 'failed')
      RETURNING ${COLS}`,
    [
      s('id', id), s('status', decision === 'approve' ? 'approved' : 'rejected'),
      s('reviewer', opts.reviewer ?? ''), s('note', opts.note ?? ''),
    ],
  );
  const proposal = rows[0] ? rowToProposal(rows[0]) : null;
  if (!proposal || decision === 'reject') return proposal;

  // Approved: write it. A failure here is recorded on the row rather than
  // thrown away, so a reviewer can see that their approval did not land.
  try {
    await applyProposal(proposal);
    const applied = await exec(
      `UPDATE graph_proposals SET status='applied', applied_at=NOW(), apply_error=NULL
        WHERE id=:id RETURNING ${COLS}`, [s('id', id)]);
    return applied[0] ? rowToProposal(applied[0]) : proposal;
  } catch (err) {
    const failed = await exec(
      `UPDATE graph_proposals SET status='failed', apply_error=:err WHERE id=:id RETURNING ${COLS}`,
      [s('id', id), s('err', (err as Error).message)],
    );
    return failed[0] ? rowToProposal(failed[0]) : proposal;
  }
}

export async function proposalStats(): Promise<Record<string, number>> {
  const base: Record<string, number> = { pending: 0, approved: 0, applied: 0, rejected: 0, failed: 0, total: 0 };
  if (config.mock.aurora) return base;
  const rows = await exec(`SELECT status, count(*)::int AS n FROM graph_proposals GROUP BY status`);
  for (const r of rows) {
    const st = toStr(r['status']);
    const n = Number(r['n'] ?? 0);
    if (st in base) base[st] = n;
    base['total'] = (base['total'] ?? 0) + n;
  }
  return base;
}
