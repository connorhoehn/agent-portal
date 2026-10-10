import type { DocumentAgentProposal } from './documentAgentEditModel.ts';
import { sendJson } from '../../../lib/writeJson.ts';

export interface StoredDocumentProposal extends DocumentAgentProposal {
  documentId: string;
  sourceId: string;
  version: number;
  createdBy: string;
  /** Which agent drafted it, when the stored metadata says (else the document drafter). */
  producer?: string;
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The label for the agent that drafted a proposal: its stored producer, else the document drafter. */
export const DOCUMENT_DRAFTER_LABEL = 'Assessment drafter';
export const proposalProducerLabel = (proposal: Pick<StoredDocumentProposal, 'producer'>): string => proposal.producer?.trim() || DOCUMENT_DRAFTER_LABEL;

export interface DocumentProposalList {
  documentId: string;
  proposals: StoredDocumentProposal[];
  canEdit: boolean;
}

export interface DocumentProposalRead extends Omit<DocumentProposalList, 'proposals'> {
  proposal: StoredDocumentProposal;
}
export class DocumentProposalReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const documentProposalUrl = (sourceId: string, proposalId: string) =>
  `/api/assessment/knowledge/doc/proposals/${encodeURIComponent(proposalId)}?id=${encodeURIComponent(sourceId)}`;
export async function getDocumentProposal(sourceId: string, proposalId: string, signal?: AbortSignal): Promise<DocumentProposalRead> {
  const response = await fetch(documentProposalUrl(sourceId, proposalId), { credentials: 'include', signal });
  const body = await response.json();
  if (!response.ok) throw new DocumentProposalReadError(response.status, body.error ?? 'The linked proposed edit could not be opened.');
  return body as DocumentProposalRead;
}

export type ProposalDecision = 'claim' | 'complete' | 'release' | 'discard';
export const documentProposalsUrl = (sourceId: string) => `/api/assessment/knowledge/doc/proposals?id=${encodeURIComponent(sourceId)}`;

export async function listDocumentProposals(sourceId: string, signal?: AbortSignal): Promise<DocumentProposalList> {
  const response = await fetch(documentProposalsUrl(sourceId), { credentials: 'include', signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Proposed edits are unavailable (HTTP ${response.status}).`);
  return body as DocumentProposalList;
}

export async function storeDocumentProposal(sourceId: string, proposal: DocumentAgentProposal): Promise<StoredDocumentProposal> {
  const { id, kind, anchor, content, originalText, cursor, instruction, summary } = proposal;
  const result = await sendJson<{ proposal: StoredDocumentProposal }>(documentProposalsUrl(sourceId), 'POST',
    { id, kind, anchor, content, originalText, cursor, instruction, ...(summary ? { summary } : {}) });
  return result.proposal;
}

export async function decideDocumentProposal(sourceId: string, proposal: StoredDocumentProposal, action: ProposalDecision): Promise<StoredDocumentProposal> {
  const url = `/api/assessment/knowledge/doc/proposals/${encodeURIComponent(proposal.id)}/decision?id=${encodeURIComponent(sourceId)}`;
  const result = await sendJson<{ proposal: StoredDocumentProposal }>(url, 'POST', { action, version: proposal.version });
  return result.proposal;
}

/** Refine ready metadata at its original target; the server owns version and actor. */
export async function reviseDocumentProposal(sourceId: string, original: StoredDocumentProposal, revised: DocumentAgentProposal): Promise<StoredDocumentProposal> {
  const url = `/api/assessment/knowledge/doc/proposals/${encodeURIComponent(original.id)}/revision?id=${encodeURIComponent(sourceId)}`;
  const { instruction, content, summary } = revised;
  const result = await sendJson<{ proposal: StoredDocumentProposal; replayed: boolean }>(url, 'POST',
    { version: original.version, instruction, content: { text: content.text }, ...(summary ? { summary } : {}) });
  return result.proposal;
}

export interface ProposalApplyOperations {
  decide: (proposal: StoredDocumentProposal, action: ProposalDecision) => Promise<StoredDocumentProposal>;
  /** Recheck the current document/editor AFTER claiming; a claim requires a network round trip. */
  insert: (proposal: StoredDocumentProposal) => void;
  /** Resolves only after the canonical document service acknowledges persistence. */
  saved: () => Promise<void>;
  claimed?: (proposal: StoredDocumentProposal) => void;
}

export type ProposalApplyResult =
  | { state: 'applied'; proposal: StoredDocumentProposal }
  | { state: 'ready'; proposal: StoredDocumentProposal; error: string }
  | { state: 'pending'; proposal: StoredDocumentProposal; error: string; saved: boolean };

const message = (error: unknown) => error instanceof Error ? error.message : 'The proposed edit could not be applied.';
/** A preflight refusal that proves no insertion was attempted. */
export class ProposalNotInsertedError extends Error {}

export function proposalReceiptMatches(value: unknown, proposal: StoredDocumentProposal): boolean {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return receipt.id === proposal.id && receipt.version === proposal.version
    && receipt.by === proposal.decidedBy && receipt.sourceId === proposal.sourceId;
}

/** Claim once before changing the editor. After insertion, uncertainty must never release the claim. */
export async function applyStoredDocumentProposal(proposal: StoredDocumentProposal, operations: ProposalApplyOperations): Promise<ProposalApplyResult> {
  const claimed = await operations.decide(proposal, 'claim');
  operations.claimed?.(claimed);
  try {
    operations.insert(claimed);
  } catch (error) {
    if (!(error instanceof ProposalNotInsertedError)) {
      return { state: 'pending', proposal: claimed, saved: false,
        error: `${message(error)} The insertion could not be confirmed. Check the saved document before making another edit.` };
    }
    try { return { state: 'ready', proposal: await operations.decide(claimed, 'release'), error: message(error) }; }
    catch { return { state: 'pending', proposal: claimed, saved: false, error: `${message(error)} The proposal remains claimed; refresh before trying again.` }; }
  }
  try { await operations.saved(); }
  catch (error) {
    return { state: 'pending', proposal: claimed, saved: false, error: `${message(error)} The edit remains pending; retry the save confirmation without applying it again.` };
  }
  try { return { state: 'applied', proposal: await operations.decide(claimed, 'complete') }; }
  catch (error) {
    return { state: 'pending', proposal: claimed, saved: true, error: `${message(error)} The document is saved, but the proposal confirmation needs to be retried.` };
  }
}

export interface DocumentPersistenceSource {
  readonly persistenceState: string;
  readonly pendingUpdateCount: number;
  flushUpdates: () => void;
  retryPersistence: () => void;
  on: (event: 'persistence', listener: () => void) => void;
  off: (event: 'persistence', listener: () => void) => void;
}

/** Reconfirm a recovered receipt through a fresh durable acknowledgement, without reinserting text. */
export async function confirmDocumentProposalReceipt(provider: DocumentPersistenceSource, receipts: {
  get: (id: string) => unknown;
  set: (id: string, receipt: Record<string, unknown>) => void;
}, proposal: StoredDocumentProposal, retry = false): Promise<void> {
  const receipt = receipts.get(proposal.id);
  if (!proposalReceiptMatches(receipt, proposal)) throw new Error('The saved document does not confirm this proposed edit yet.');
  // A snapshot can contain an in-memory update whose earlier save failed.
  // Touch only its receipt and wait for the normal snapshot commit protocol.
  receipts.set(proposal.id, { ...(receipt as Record<string, unknown>), confirmationId: crypto.randomUUID() });
  await waitForDocumentProposalSave(provider, retry);
  if (!proposalReceiptMatches(receipts.get(proposal.id), proposal)) throw new Error('The proposed edit changed before its save could be confirmed.');
}

/** Wait for the provider's commit acknowledgement, not the editor's local transaction result. */
export function waitForDocumentProposalSave(provider: DocumentPersistenceSource, retry = false, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      clearTimeout(timer); provider.off('persistence', changed);
      if (error) reject(error); else resolve();
    };
    const changed = () => {
      if (provider.persistenceState === 'saved' && provider.pendingUpdateCount === 0) finish();
      else if (provider.persistenceState === 'error') finish(new Error('The document service has not saved the edit.'));
    };
    timer = setTimeout(() => finish(new Error('The document save has not been confirmed yet.')), timeoutMs);
    provider.on('persistence', changed);
    try {
      if (retry) provider.retryPersistence(); else provider.flushUpdates();
      changed();
    } catch (error) { finish(new Error(message(error))); }
  });
}
