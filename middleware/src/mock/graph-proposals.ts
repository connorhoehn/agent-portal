// Agent-proposed graph changes, offline — `graph_proposals`.
//
// The page at /iq/work/changes read "No agent has proposed a graph change yet"
// for a world where agents ingest documents all day. These are the proposals
// that ingest left: the auth runbook, the post-mortems and the design review
// each leave a handful, a reviewer has already applied some and rejected one,
// and two wait. Declarative payloads only (kind + payload), as the real table
// holds them; the payload carries display names beside the ids so a reviewer
// reads people and skills, not `p-004`.
//
// Stamps are clock offsets, resolved in the factory, so "applied 2 days ago"
// stays two days ago however long the process has been up. `decideProposal`
// (providers/graph-proposals.ts) mutates these rows in place, which is what a
// reset undoes.

import { clock, defineFixture } from './core/index.js';
import type { GraphProposal } from '../providers/graph-proposals.js';

function proposal(over: Partial<GraphProposal> & Pick<GraphProposal, 'id' | 'kind' | 'targetType' | 'targetId' | 'payload' | 'status' | 'createdAt'>): GraphProposal {
  return {
    source: 'orgiq-ingestion', jobId: null, findingId: null, rationale: null, evidence: {}, confidence: null,
    reviewer: null, reviewNote: null, applyError: null, decidedAt: null, appliedAt: null, ...over,
  };
}

export const graphProposals = defineFixture<GraphProposal>({
  key: 'graph-proposals',
  scenarios: {
    default: () => [
      proposal({
        id: 'gp-0001', kind: 'add_person_skill', targetType: 'person', targetId: 'p-004', status: 'applied',
        payload: { personId: 'p-004', personName: 'Nora DaSilva', skillId: 'sk-zero-trust', skillName: 'Zero Trust', weight: 0.7 },
        rationale: 'Nora wrote the rehearsal plan for the tenant cutover runbook and the section on isolating tenants during the flip.',
        evidence: { document: 'Tenant-by-tenant cutover runbook', section: 'Rehearsal plan' }, confidence: 0.86,
        createdAt: clock.daysAgo(5), decidedAt: clock.daysAgo(4), appliedAt: clock.daysAgo(4), reviewer: 'u-rachel',
      }),
      proposal({
        id: 'gp-0002', kind: 'add_person_skill', targetType: 'person', targetId: 'p-051', status: 'applied',
        payload: { personId: 'p-051', personName: 'Simone Chang', skillId: 'sk-iam', skillName: 'IAM', weight: 0.8 },
        rationale: 'Simone authored the session-hardening review and the IAM section of the auth post-mortem.',
        evidence: { document: 'Session hygiene design review' }, confidence: 0.91,
        createdAt: clock.daysAgo(5), decidedAt: clock.daysAgo(4), appliedAt: clock.daysAgo(4), reviewer: 'u-rachel',
      }),
      proposal({
        id: 'gp-0003', kind: 'link_document_mention', targetType: 'document', targetId: 'adr-d-vectordb', status: 'applied',
        payload: { documentId: 'adr-d-vectordb', documentTitle: 'ADR: Vector DB vendor selection', entityType: 'project', entityId: 'p-rag-search', entityName: 'RAG Knowledge Search' },
        rationale: 'The ADR names pgvector inside Aurora as the retrieval store and cites the RAG Knowledge Search rollout.',
        confidence: 0.94, createdAt: clock.daysAgo(3), decidedAt: clock.daysAgo(2), appliedAt: clock.daysAgo(2), reviewer: 'u-rachel',
      }),
      proposal({
        id: 'gp-0004', kind: 'update_person_title', targetType: 'person', targetId: 'p-005', status: 'rejected',
        payload: { personId: 'p-005', personName: 'Sienna Garcia', title: 'VP Engineering' },
        rationale: 'A Slack thread calls Sienna "our VP"; the extractor took it as a title.',
        evidence: { source: 'Slack thread in #auth-migration' }, confidence: 0.41,
        createdAt: clock.daysAgo(2), decidedAt: clock.daysAgo(1), reviewer: 'u-rachel',
        reviewNote: 'She is the release manager. The thread was a joke.',
      }),
      proposal({
        id: 'gp-0005', kind: 'add_collaboration', targetType: 'person', targetId: 'p-004', status: 'pending',
        payload: { personAId: 'p-004', personAName: 'Nora DaSilva', personBId: 'p-001', personBName: 'Theo Chang', weight: 0.6 },
        rationale: 'Nora and Theo traded eleven messages and a pull request review while arguing the cutover order.',
        evidence: { channel: '#auth-migration', messages: 11 }, confidence: 0.78,
        createdAt: clock.hoursAgo(20),
      }),
      proposal({
        id: 'gp-0006', kind: 'link_document_mention', targetType: 'document', targetId: 'adr-d-vectordb', status: 'pending',
        payload: { documentId: 'adr-d-vectordb', documentTitle: 'ADR: Vector DB vendor selection', entityType: 'project', entityId: 'p-llm-platform', entityName: 'LLM Application Platform' },
        rationale: 'The ADR cites the LLM Application Platform prompt registry as a consumer of the retrieval store.',
        confidence: 0.69, createdAt: clock.hoursAgo(6),
      }),
    ],
    empty: () => [],
    // "No agent has proposed a change" and "the proposals could not be read" are
    // opposite facts for a reviewer deciding what is waiting on them.
    error: () => { throw new Error('graph_proposals unavailable: relation does not exist'); },
  },
});
