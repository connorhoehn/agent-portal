/** Draft edit metadata only. The collaborative document remains the Yjs canvas. */
export type DocumentProposalStatus = 'ready' | 'applying' | 'applied' | 'discarded';
export interface DocumentProposalInput {
  id: string;
  kind: 'insert' | 'replace';
  anchor: 'cursor' | { from: number; to: number };
  content: { text: string };
  originalText: string;
  cursor: number;
  instruction: string;
  summary?: string;
}
export interface DocumentEditProposal extends DocumentProposalInput {
  documentId: string;
  sourceId: string;
  status: DocumentProposalStatus;
  version: number;
  createdBy: string;
  /** The agent that drafted this edit, as a display label; null for rows stored before it was recorded. */
  producer: string | null;
  /** The latest revision/decision actor; an applying row identifies its claim actor. */
  decidedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export type DocumentProposalAction = 'claim' | 'complete' | 'release' | 'discard';
export interface DocumentProposalRevision {
  version: number;
  instruction: string;
  content: { text: string };
  summary?: string;
}
export interface DocumentProposalRevisionResult {
  documentId: string;
  proposal: DocumentEditProposal;
  replayed: boolean;
}
/** Proposals arrive only from the document drafter's result, so the server records that agent itself; clients cannot name one. */
export const DOCUMENT_DRAFTER_AGENT = 'orgiq-assessment-drafter';
const PRODUCER_LABELS: Record<string, string> = { [DOCUMENT_DRAFTER_AGENT]: 'Assessment drafter' };
export const producerLabel = (agentId: unknown): string | null => typeof agentId === 'string' ? PRODUCER_LABELS[agentId] ?? null : null;
export class DocumentProposalError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function proposalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new DocumentProposalError(400, 'Invalid proposed edit id');
  }
  return value;
}
const position = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_000_000;
function text(value: unknown, max: number, name: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\u0000') || (!empty && !value.trim())) {
    throw new DocumentProposalError(400, `Invalid proposed edit ${name}`);
  }
  return value;
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new DocumentProposalError(400, 'Invalid proposed edit fields');
  return value as Record<string, unknown>;
}
/** Browser data grants no actor, lifecycle state, or editing authority. */
export function parseDocumentProposal(value: unknown): DocumentProposalInput {
  const body = record(value, ['id', 'kind', 'anchor', 'content', 'originalText', 'cursor', 'instruction', 'summary']);
  const id = proposalId(body.id);
  if (body.kind !== 'insert' && body.kind !== 'replace') throw new DocumentProposalError(400, 'Invalid proposed edit kind');
  if (!position(body.cursor)) throw new DocumentProposalError(400, 'Invalid proposed edit cursor');
  let anchor: DocumentProposalInput['anchor'];
  if (body.kind === 'insert' && body.anchor === 'cursor') anchor = 'cursor';
  else if (body.kind === 'replace') {
    const range = record(body.anchor, ['from', 'to']);
    if (!position(range.from) || !position(range.to) || range.from >= range.to) throw new DocumentProposalError(400, 'Invalid proposed edit selection');
    anchor = { from: range.from, to: range.to };
  } else throw new DocumentProposalError(400, 'Invalid proposed edit anchor');
  const content = record(body.content, ['text']);
  const originalText = text(body.originalText, 24_000, 'original text', body.kind === 'insert');
  return { id, kind: body.kind, anchor, cursor: body.cursor, originalText,
    instruction: text(body.instruction, 2000, 'instruction'), content: { text: text(content.text, 24_000, 'content') },
    ...(body.summary === undefined ? {} : { summary: text(body.summary, 500, 'summary') }) };
}
export function parseDocumentProposalDecision(value: unknown): { action: DocumentProposalAction; version: number } {
  const body = record(value, ['action', 'version']);
  if (!['claim', 'complete', 'release', 'discard'].includes(String(body.action))
    || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    throw new DocumentProposalError(400, 'A proposed edit action and current version are required');
  }
  return { action: body.action as DocumentProposalAction, version: body.version };
}
/** A revision cannot retarget the edit or supply an actor, author or lifecycle state. */
export function parseDocumentProposalRevision(value: unknown): DocumentProposalRevision {
  const body = record(value, ['version', 'instruction', 'content', 'summary']);
  if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    throw new DocumentProposalError(400, 'A current proposed edit version is required');
  }
  const content = record(body.content, ['text']);
  return { version: body.version, instruction: text(body.instruction, 2000, 'instruction'),
    content: { text: text(content.text, 24_000, 'content') },
    ...(body.summary === undefined ? {} : { summary: text(body.summary, 500, 'summary') }) };
}
export function proposalTransition(action: DocumentProposalAction): { from: DocumentProposalStatus; to: DocumentProposalStatus; claimActor: boolean } {
  switch (action) {
    case 'claim': return { from: 'ready', to: 'applying', claimActor: false };
    case 'complete': return { from: 'applying', to: 'applied', claimActor: true };
    case 'release': return { from: 'applying', to: 'ready', claimActor: true };
    case 'discard': return { from: 'ready', to: 'discarded', claimActor: false };
  }
}
export function cloneDocumentProposal(row: DocumentEditProposal): DocumentEditProposal {
  return { ...row, content: { ...row.content }, anchor: typeof row.anchor === 'string' ? row.anchor : { ...row.anchor } };
}
export function sameDocumentProposal(a: DocumentProposalInput, b: DocumentProposalInput): boolean {
  return a.id === b.id && a.kind === b.kind && JSON.stringify(a.anchor) === JSON.stringify(b.anchor)
    && a.content.text === b.content.text && a.originalText === b.originalText && a.cursor === b.cursor
    && a.instruction === b.instruction && a.summary === b.summary;
}
