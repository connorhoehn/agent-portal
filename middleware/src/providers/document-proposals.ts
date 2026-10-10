import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { isAllowed } from '../lib/authz.js';
import { assessmentBroker } from '../lib/assessment-broker.js';
import { currentDocumentSessionEpoch, documentSessionId } from '../lib/document-session.js';
import { assessmentDocumentHref, notificationSinkActive, notify } from '../lib/social-notify.js';
import type { Session } from '../lib/session.js';
import { clock } from '../mock/core/clock.js';
import { documentProposalsFixture } from '../mock/document-proposals.js';
import { exec } from './aurora.js';
import { getKnowledgeDoc } from './assessment.js';
import { canvasSourceEditable } from './document-editability.js';
import { documentSourceRevision, ensureDocumentMapping } from './document-mapping.js';
import { performDocumentWorkflow } from './document-workflows.js';
import {
  cloneDocumentProposal, DOCUMENT_DRAFTER_AGENT, DocumentProposalError, producerLabel, proposalId, proposalTransition, sameDocumentProposal,
  type DocumentEditProposal, type DocumentProposalAction, type DocumentProposalInput,
  type DocumentProposalRevision, type DocumentProposalRevisionResult,
} from '../lib/document-proposals.js';

const s = (name: string, value: string | null): SqlParameter => ({ name, value: value === null ? { isNull: true } : { stringValue: value } });
const n = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const ISO = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const columns = `proposal_id, document_id::text, source_id, kind, anchor::text, content, original_text, cursor_position,
  instruction, summary, status, version, created_by, producer_agent, decided_by, ${ISO('created_at')} AS created_at, ${ISO('updated_at')} AS updated_at`;
function rowToProposal(row: Record<string, unknown>): DocumentEditProposal {
  return { id: String(row.proposal_id), documentId: String(row.document_id), sourceId: String(row.source_id),
    kind: row.kind as DocumentEditProposal['kind'], anchor: JSON.parse(String(row.anchor)),
    content: { text: String(row.content) }, originalText: String(row.original_text), cursor: Number(row.cursor_position),
    instruction: String(row.instruction), ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    status: row.status as DocumentEditProposal['status'], version: Number(row.version), createdBy: String(row.created_by), producer: producerLabel(row.producer_agent),
    decidedBy: typeof row.decided_by === 'string' ? row.decided_by : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
async function access(sourceId: string, session: Session, writing = false) {
  if (session.tenant !== 'assessment') throw new DocumentProposalError(403, 'Switch to the assessment tenant before opening proposed edits');
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 1024 || /[\u0000-\u001f]/.test(sourceId)) {
    throw new DocumentProposalError(400, 'Document id required');
  }
  const epoch = await currentDocumentSessionEpoch(session.sub, 'assessment', documentSessionId(session));
  if (epoch === null || !await isAllowed(session, 'ViewAssessment')) throw new DocumentProposalError(403, 'Document access is no longer authorized');
  const source = await getKnowledgeDoc(sourceId);
  if (!source) throw new DocumentProposalError(404, 'Document not found');
  const mapping = await ensureDocumentMapping(sourceId, documentSourceRevision(source.markdown));
  const canEdit = canvasSourceEditable(source) && await isAllowed(session, 'ManageKnowledge');
  if (writing) {
    if (!canEdit) throw new DocumentProposalError(403, 'Document editing permission required');
    const policy = await performDocumentWorkflow(sourceId, session, { kind: 'write-policy', method: 'GET' });
    if (policy.status !== 200) throw new DocumentProposalError(policy.status, 'Document write policy is unavailable');
    if (policy.body.documentId !== mapping.document_id || policy.body.canWrite !== true) {
      throw new DocumentProposalError(409, 'Document content is locked');
    }
  }
  return { source, documentId: mapping.document_id, canEdit };
}
async function readCanEdit(sourceId: string, session: Session, grant: { documentId: string; canEdit: boolean }): Promise<boolean> {
  if (grant.canEdit) {
    try {
      const policy = await performDocumentWorkflow(sourceId, session, { kind: 'write-policy', method: 'GET' });
      return policy.status === 200 && policy.body.documentId === grant.documentId && policy.body.canWrite === true;
    } catch { /* Drafts remain readable while the canvas policy is unavailable. */ }
  }
  return false;
}
export async function listDocumentProposals(sourceId: string, session: Session) {
  const grant = await access(sourceId, session);
  const canEdit = await readCanEdit(sourceId, session, grant);
  const proposals = config.mock.aurora
    ? documentProposalsFixture.rows().filter(row => row.documentId === grant.documentId)
      .sort((a, b) => Number(!['ready', 'applying'].includes(a.status)) - Number(!['ready', 'applying'].includes(b.status))
        || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 100).map(cloneDocumentProposal)
    : (await exec(`SELECT ${columns} FROM assessment_document_proposals WHERE document_id = :document
        ORDER BY CASE WHEN status IN ('ready', 'applying') THEN 0 ELSE 1 END,
        created_at DESC, proposal_id DESC LIMIT 100`, [s('document', grant.documentId)])).map(rowToProposal);
  return { documentId: grant.documentId, proposals, canEdit };
}
/** Notification targets remain readable after a decision or beyond the active-list limit. */
export async function getDocumentProposal(sourceId: string, session: Session, id: string) {
  proposalId(id);
  const grant = await access(sourceId, session);
  const proposal = config.mock.aurora
    ? documentProposalsFixture.rows().find(row => row.documentId === grant.documentId && row.sourceId === sourceId && row.id === id)
    : (await exec(`SELECT ${columns} FROM assessment_document_proposals
        WHERE document_id = :document AND source_id = :source AND proposal_id = :id`,
      [s('document', grant.documentId), s('source', sourceId), s('id', id)])).map(rowToProposal)[0];
  if (!proposal) throw new DocumentProposalError(404, 'Proposed edit not found');
  return { documentId: grant.documentId, proposal: cloneDocumentProposal(proposal), canEdit: await readCanEdit(sourceId, session, grant) };
}
function announce(proposal: DocumentEditProposal, by: string): void {
  assessmentBroker.publish({ type: 'knowledge.proposal.changed', doc_id: proposal.sourceId, id: proposal.id,
    status: proposal.status, version: proposal.version, by, ts: proposal.updatedAt });
}
/** The actor and the canonical lifecycle owner are resolved at the server. */
async function notifyOwner(sourceId: string, title: string, session: Session, proposal: DocumentEditProposal): Promise<void> {
  if (!notificationSinkActive()) return;
  try {
    const result = await performDocumentWorkflow(sourceId, session, { kind: 'lifecycle', method: 'GET' });
    const owner = (result.body.lifecycle as { ownerId?: unknown } | undefined)?.ownerId;
    if (result.status !== 200 || result.body.documentId !== proposal.documentId || typeof owner !== 'string' || !owner || owner === session.sub) return;
    await notify([owner], { id: `document-proposal:${proposal.documentId}:${proposal.id}`, type: 'approval-requested',
      title: `A proposed edit is ready for ${title}`, body: proposal.summary ?? proposal.instruction,
      payload: { tenant: 'assessment', kind: 'document-proposal', docId: sourceId, proposalId: proposal.id, authorId: session.sub },
      action: { label: 'Review the proposed edit', href: `${assessmentDocumentHref(sourceId, 'editor')}&proposal=${encodeURIComponent(proposal.id)}` } });
  } catch { /* The proposal is stored; delivery never changes that success. */ }
}
export async function createDocumentProposal(sourceId: string, session: Session, input: DocumentProposalInput) {
  const grant = await access(sourceId, session, true);
  let proposal: DocumentEditProposal;
  let created = false;
  if (config.mock.aurora) {
    const rows = documentProposalsFixture.rows();
    const previous = rows.find(row => row.documentId === grant.documentId && row.id === input.id);
    if (previous) proposal = cloneDocumentProposal(previous);
    else {
      const now = clock.nowIso();
      proposal = { ...input, documentId: grant.documentId, sourceId, status: 'ready', version: 1,
        createdBy: session.sub, producer: producerLabel(DOCUMENT_DRAFTER_AGENT), decidedBy: null, createdAt: now, updatedAt: now };
      rows.push(cloneDocumentProposal(proposal)); created = true;
    }
  } else {
    const rows = await exec(`INSERT INTO assessment_document_proposals
      (document_id, proposal_id, source_id, kind, anchor, content, original_text, cursor_position, instruction, summary, created_by, producer_agent)
      VALUES (:document, :id, :source, :kind, CAST(:anchor AS jsonb), :content, :original, :cursor, :instruction, :summary, :by, :agent)
      ON CONFLICT (document_id, proposal_id) DO NOTHING RETURNING ${columns}`,
    [s('document', grant.documentId), s('id', input.id), s('source', sourceId), s('kind', input.kind), s('anchor', JSON.stringify(input.anchor)),
      s('content', input.content.text), s('original', input.originalText), n('cursor', input.cursor),
      s('instruction', input.instruction), s('summary', input.summary ?? null), s('by', session.sub), s('agent', DOCUMENT_DRAFTER_AGENT)]);
    created = rows.length === 1;
    const stored = rows[0] ?? (await exec(`SELECT ${columns} FROM assessment_document_proposals
      WHERE document_id = :document AND proposal_id = :id`, [s('document', grant.documentId), s('id', input.id)]))[0];
    if (!stored) throw new DocumentProposalError(503, 'The proposed edit was not stored');
    proposal = rowToProposal(stored);
  }
  if (proposal.createdBy !== session.sub || !sameDocumentProposal(input, proposal)) {
    throw new DocumentProposalError(409, 'This proposed edit id already names a different edit');
  }
  if (created) {
    announce(proposal, session.sub);
    void notifyOwner(sourceId, grant.source.title, session, proposal);
  }
  return { documentId: grant.documentId, proposal: cloneDocumentProposal(proposal), created };
}
function revisionReplay(proposal: DocumentEditProposal, input: DocumentProposalRevision, by: string): boolean {
  return proposal.status === 'ready' && proposal.version === input.version + 1 && proposal.decidedBy === by
    && proposal.content.text === input.content.text && proposal.instruction === input.instruction && proposal.summary === input.summary;
}
/** Change a ready draft's content, never its original document target or canonical content. */
export async function reviseDocumentProposal(sourceId: string, session: Session, id: string, input: DocumentProposalRevision): Promise<DocumentProposalRevisionResult> {
  proposalId(id);
  const grant = await access(sourceId, session, true);
  let proposal: DocumentEditProposal;
  if (config.mock.aurora) {
    const row = documentProposalsFixture.rows().find(value => value.documentId === grant.documentId && value.sourceId === sourceId && value.id === id);
    if (!row) throw new DocumentProposalError(404, 'Proposed edit not found');
    if (revisionReplay(row, input, session.sub)) return { documentId: grant.documentId, proposal: cloneDocumentProposal(row), replayed: true };
    if (row.status !== 'ready' || row.version !== input.version) throw new DocumentProposalError(409, 'The proposed edit changed. Reload it before revising.');
    row.content = { ...input.content }; row.instruction = input.instruction;
    if (input.summary === undefined) delete row.summary; else row.summary = input.summary;
    row.version += 1; row.decidedBy = session.sub; row.updatedAt = clock.nowIso();
    proposal = cloneDocumentProposal(row);
  } else {
    const rows = await exec(`UPDATE assessment_document_proposals SET content = :content, instruction = :instruction,
      summary = :summary, version = version + 1, decided_by = :by, updated_at = NOW()
      WHERE document_id = :document AND source_id = :source AND proposal_id = :id
      AND status = 'ready' AND version = :version RETURNING ${columns}`,
    [s('content', input.content.text), s('instruction', input.instruction), s('summary', input.summary ?? null), s('by', session.sub),
      s('document', grant.documentId), s('source', sourceId), s('id', id), n('version', input.version)]);
    if (!rows[0]) {
      const current = (await exec(`SELECT ${columns} FROM assessment_document_proposals
        WHERE document_id = :document AND source_id = :source AND proposal_id = :id`,
      [s('document', grant.documentId), s('source', sourceId), s('id', id)]))[0];
      if (!current) throw new DocumentProposalError(404, 'Proposed edit not found');
      const row = rowToProposal(current);
      if (revisionReplay(row, input, session.sub)) return { documentId: grant.documentId, proposal: row, replayed: true };
      throw new DocumentProposalError(409, 'The proposed edit changed. Reload it before revising.');
    }
    proposal = rowToProposal(rows[0]);
  }
  announce(proposal, session.sub);
  return { documentId: grant.documentId, proposal, replayed: false };
}
/** The claim is never auto-released: a lost browser may already have inserted the edit. */
export async function decideDocumentProposal(sourceId: string, session: Session, id: string, action: DocumentProposalAction, version: number) {
  proposalId(id);
  const grant = await access(sourceId, session, true);
  const transition = proposalTransition(action);
  let proposal: DocumentEditProposal;
  if (config.mock.aurora) {
    const row = documentProposalsFixture.rows().find(value => value.documentId === grant.documentId && value.id === id);
    if (!row) throw new DocumentProposalError(404, 'Proposed edit not found');
    // Retrying a lost confirmation cannot insert again. A claim is deliberately
    // never idempotent: two tabs of the same actor must not both receive it.
    if (action === 'complete' && row.status === 'applied' && row.version === version + 1 && row.decidedBy === session.sub) {
      return { documentId: grant.documentId, proposal: cloneDocumentProposal(row) };
    }
    if (row.version !== version || row.status !== transition.from) throw new DocumentProposalError(409, 'The proposed edit changed. Reload it before deciding.');
    if (transition.claimActor && row.decidedBy !== session.sub) throw new DocumentProposalError(403, 'Another editor is applying this proposed edit');
    row.status = transition.to; row.version += 1; row.decidedBy = action === 'release' ? null : session.sub; row.updatedAt = clock.nowIso();
    proposal = cloneDocumentProposal(row);
  } else {
    const rows = await exec(`UPDATE assessment_document_proposals SET status = :next, version = version + 1,
      decided_by = :decider, updated_at = NOW() WHERE document_id = :document AND proposal_id = :id
      AND status = :previous AND version = :version ${transition.claimActor ? 'AND decided_by = :by' : ''} RETURNING ${columns}`,
    [s('next', transition.to), s('decider', action === 'release' ? null : session.sub), s('document', grant.documentId),
      s('id', id), s('previous', transition.from), n('version', version), ...(transition.claimActor ? [s('by', session.sub)] : [])]);
    if (!rows[0]) {
      const current = (await exec(`SELECT ${columns} FROM assessment_document_proposals WHERE document_id = :document AND proposal_id = :id`,
        [s('document', grant.documentId), s('id', id)]))[0];
      if (!current) throw new DocumentProposalError(404, 'Proposed edit not found');
      const row = rowToProposal(current);
      if (action === 'complete' && row.status === 'applied' && row.version === version + 1 && row.decidedBy === session.sub) {
        return { documentId: grant.documentId, proposal: row };
      }
      if (row.status === transition.from && row.version === version && transition.claimActor && row.decidedBy !== session.sub) {
        throw new DocumentProposalError(403, 'Another editor is applying this proposed edit');
      }
      throw new DocumentProposalError(409, 'The proposed edit changed. Reload it before deciding.');
    }
    proposal = rowToProposal(rows[0]);
  }
  announce(proposal, session.sub);
  return { documentId: grant.documentId, proposal };
}
