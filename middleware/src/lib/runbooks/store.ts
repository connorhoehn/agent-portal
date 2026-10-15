// The runbook store (docs/distillation-runbooks-design.md §2.5): ONE interface,
// two implementations — RowsRunbookStore (store-rows.ts, registered mock
// fixtures; the contract) and DynamoRunbookStore (store-dynamo.ts, single
// table, conditional writes; the durable one). Everything in lib/runbooks,
// routes and injection reads and writes through this interface and nothing
// else. No SQL dependency of any kind.
//
// What the interface guarantees (the shared contract suite proves it for both):
//  * Optimistic concurrency. A version is appended against the current version
//    it was built on; a stale one fails with VersionConflictError and writes
//    nothing. Accepting a proposal whose base_version is no longer current
//    fails the same way.
//  * A proposal is decided once. A second accept/reject/merge fails with
//    ProposalClosedError; of two concurrent accepts exactly one wins.
//  * A proposer never accepts their own proposal (SelfAcceptError). Who MAY
//    accept (owner / SME / org-leader) is the route's Cedar check, not here.
//  * A session brief is write-once per run_ref (the frozen bytes): re-putting
//    the same sha is a no-op, a different sha fails with BriefExistsError.
//  * Reads return copies: mutating a result never changes the store.
//
// Timestamps are passed in (`at`), never read here, so the Rows store stays on
// the mock clock and the Dynamo store on the real one without either knowing.

import type {
  Runbook, RunbookApplication, RunbookDoc, RunbookProposal, RunbookScope, RunbookStatus, RunbookVersion, SessionBrief,
} from './types.js';

export interface Page<T> { items: T[]; /** Opaque; pass back as `cursor`. null when exhausted. */ next: string | null }

export interface ListRunbooksQuery {
  scope?: RunbookScope;
  status?: RunbookStatus[];
  /** Every whitespace-separated term must appear in id + title + summary + scope ref + keywords. */
  text?: string;
  cursor?: string;
  limit?: number;
}
export interface ListProposalsQuery {
  status?: RunbookProposal['status'][];
  runbook_id?: string;
  cursor?: string;
  limit?: number;
}
export interface ListBriefsQuery { cursor?: string; limit?: number }

export interface AcceptProposalInput {
  proposal_id: string;
  /** The person accepting (p-…). Must not be the proposal's own proposer. */
  decided_by: string;
  at: string;
  note?: string | null;
  /** kind 'edit' (version = base_version + 1) and 'new' (version 1): the version to write. proposal_id/accepted_* are stamped by the store. */
  version?: RunbookVersion;
  /** kind 'new': the runbook row to create (current_version 1). */
  runbook?: Runbook;
  /** kind 'retire'. */
  retire?: { reason: string; superseded_by: string | null };
}
export interface AcceptProposalResult { proposal: RunbookProposal; runbook: Runbook; version: RunbookVersion | null }

export interface DecideProposalInput {
  proposal_id: string;
  decision: 'rejected' | 'merged';
  decided_by: string;
  at: string;
  note?: string | null;
  /** merged: the proposal this one was folded into. */
  merged_into?: string | null;
}

export interface RunbookStore {
  readonly kind: 'rows' | 'dynamo';

  getRunbook(id: string): Promise<Runbook | null>;
  /** Newest `updated_at` first, then id. */
  listRunbooks(q?: ListRunbooksQuery): Promise<Page<Runbook>>;
  /** Create a runbook and its version 1 together; fails AlreadyExistsError if the id is taken. */
  createRunbook(runbook: Runbook, v1: RunbookVersion): Promise<void>;
  /** Rewrite the runbook row (owner, scope, retire…). Conditional on `updated_at`; current_version must not change here. */
  putRunbook(runbook: Runbook, expectedUpdatedAt: string): Promise<void>;

  getVersion(runbookId: string, version: number): Promise<RunbookVersion | null>;
  /** Ascending by version. */
  listVersions(runbookId: string): Promise<RunbookVersion[]>;
  /** Append version `expectedCurrent + 1` and move the runbook to it, atomically; VersionConflictError unless current_version === expectedCurrent. */
  putVersion(v: RunbookVersion, expectedCurrent: number, at: string): Promise<void>;

  getProposal(id: string): Promise<RunbookProposal | null>;
  /** Create, or replace while still open. A decided proposal is never rewritten. */
  putProposal(p: RunbookProposal): Promise<void>;
  /** Newest first, then id. */
  listProposals(q?: ListProposalsQuery): Promise<Page<RunbookProposal>>;
  /** Accept: writes the version / runbook / decision as one atomic step. */
  acceptProposal(input: AcceptProposalInput): Promise<AcceptProposalResult>;
  /** Reject or merge; once only. */
  decideProposal(input: DecideProposalInput): Promise<RunbookProposal>;

  appendApplication(a: RunbookApplication): Promise<void>;
  /** Ascending by `at`, then id. */
  listApplications(runbookId: string, version?: number): Promise<RunbookApplication[]>;

  /** Write-once per run_ref. */
  putBrief(b: SessionBrief): Promise<void>;
  getBrief(runRef: string): Promise<SessionBrief | null>;
  /** Newest `assembled_at` first. */
  listBriefs(q?: ListBriefsQuery): Promise<Page<SessionBrief>>;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type RunbookStoreErrorCode =
  | 'version_conflict' | 'proposal_closed' | 'self_accept' | 'not_found' | 'already_exists' | 'brief_exists' | 'invalid';

export class RunbookStoreError extends Error {
  constructor(readonly code: RunbookStoreErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class VersionConflictError extends RunbookStoreError {
  constructor(message: string, readonly expected: number | string | null = null, readonly actual: number | string | null = null) { super('version_conflict', message); }
}
export class ProposalClosedError extends RunbookStoreError {
  constructor(id: string, readonly status: string) { super('proposal_closed', `proposal ${id} is already ${status}`); }
}
export class SelfAcceptError extends RunbookStoreError {
  constructor(id: string) { super('self_accept', `a proposer cannot accept their own proposal (${id})`); }
}
export class NotFoundError extends RunbookStoreError {
  constructor(what: string) { super('not_found', `${what} not found`); }
}
export class AlreadyExistsError extends RunbookStoreError {
  constructor(what: string) { super('already_exists', `${what} already exists`); }
}
export class BriefExistsError extends RunbookStoreError {
  constructor(runRef: string) { super('brief_exists', `a different brief is already frozen for ${runRef}`); }
}
export class InvalidWriteError extends RunbookStoreError {
  constructor(message: string) { super('invalid', message); }
}

// ── Shared pure rules (both stores run these; the contract suite proves it) ──

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function clone<T>(v: T): T { return structuredClone(v); }

/** Slice an already-ordered list; the cursor is an opaque offset. */
export function paginate<T>(all: readonly T[], cursor: string | undefined, limit: number | undefined): Page<T> {
  const size = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_LIMIT) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  let offset = 0;
  if (cursor) {
    offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new InvalidWriteError('invalid cursor');
  }
  const items = all.slice(offset, offset + size);
  const end = offset + items.length;
  return { items, next: end < all.length ? Buffer.from(String(end), 'utf8').toString('base64url') : null };
}

export const byNewest = <T>(stamp: (t: T) => string, id: (t: T) => string) => (a: T, b: T): number =>
  stamp(b).localeCompare(stamp(a)) || id(a).localeCompare(id(b));

export function scopeEquals(a: RunbookScope, b: RunbookScope): boolean { return a.kind === b.kind && (a.ref ?? null) === (b.ref ?? null); }

export function runbookSearchText(r: Runbook, doc: RunbookDoc | null): string {
  return [r.id, r.scope.ref ?? '', doc?.title ?? '', doc?.summary ?? '', ...(doc?.triggers.keywords ?? [])].join(' ').toLowerCase();
}
export function matchesText(text: string | undefined, haystack: string): boolean {
  const terms = (text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => haystack.includes(t));
}
export function filterRunbooks(rows: Runbook[], q: ListRunbooksQuery | undefined): Runbook[] {
  return rows.filter((r) => (!q?.scope || scopeEquals(r.scope, q.scope)) && (!q?.status?.length || q.status.includes(r.status)));
}
export function filterProposals(rows: RunbookProposal[], q: ListProposalsQuery | undefined): RunbookProposal[] {
  return rows.filter((p) => (!q?.status?.length || q.status.includes(p.status)) && (!q?.runbook_id || p.runbook_id === q.runbook_id));
}

/** The writes an accept makes, or the typed error that stops it. Pure: both stores call this, then apply the plan atomically. */
export function planAccept(
  proposal: RunbookProposal | null, runbook: Runbook | null, input: AcceptProposalInput,
): AcceptProposalResult {
  if (!proposal) throw new NotFoundError(`proposal ${input.proposal_id}`);
  if (proposal.status !== 'open') throw new ProposalClosedError(proposal.id, proposal.status);
  if (proposal.source.kind === 'person' && proposal.source.person_id && proposal.source.person_id === input.decided_by) throw new SelfAcceptError(proposal.id);

  const decided: RunbookProposal = {
    ...clone(proposal), status: 'accepted', decided_by: input.decided_by, decided_at: input.at, note: input.note ?? null,
  };
  const stamp = (v: RunbookVersion): RunbookVersion => ({
    ...clone(v), proposal_id: proposal.id, accepted_by: input.decided_by, accepted_at: input.at,
  });

  if (proposal.kind === 'new') {
    if (!input.runbook || !input.version) throw new InvalidWriteError("accepting a 'new' proposal needs runbook and version");
    if (runbook) throw new AlreadyExistsError(`runbook ${runbook.id}`);
    if (input.version.version !== 1 || input.runbook.current_version !== 1 || input.version.runbook_id !== input.runbook.id) {
      throw new InvalidWriteError('a new runbook starts at version 1 under its own id');
    }
    return { proposal: decided, runbook: { ...clone(input.runbook), created_at: input.at, updated_at: input.at }, version: stamp(input.version) };
  }

  if (!runbook) throw new NotFoundError(`runbook ${proposal.runbook_id}`);
  if (proposal.base_version !== null && proposal.base_version !== runbook.current_version) {
    throw new VersionConflictError(
      `proposal ${proposal.id} was written against v${proposal.base_version}; ${runbook.id} is at v${runbook.current_version}`,
      proposal.base_version, runbook.current_version,
    );
  }
  if (proposal.kind === 'retire') {
    if (!input.retire) throw new InvalidWriteError("accepting a 'retire' proposal needs retire");
    return {
      proposal: decided, version: null,
      runbook: { ...clone(runbook), status: 'retired', updated_at: input.at, retired: { at: input.at, by: input.decided_by, ...input.retire } },
    };
  }
  if (!input.version) throw new InvalidWriteError("accepting an 'edit' proposal needs version");
  if (input.version.runbook_id !== runbook.id || input.version.version !== runbook.current_version + 1) {
    throw new VersionConflictError(`${runbook.id} accepts v${runbook.current_version + 1}, not v${input.version.version}`, runbook.current_version + 1, input.version.version);
  }
  return { proposal: decided, version: stamp(input.version), runbook: { ...clone(runbook), current_version: input.version.version, updated_at: input.at } };
}

export function planDecision(proposal: RunbookProposal | null, input: DecideProposalInput): RunbookProposal {
  if (!proposal) throw new NotFoundError(`proposal ${input.proposal_id}`);
  if (proposal.status !== 'open') throw new ProposalClosedError(proposal.id, proposal.status);
  return {
    ...clone(proposal), status: input.decision, decided_by: input.decided_by, decided_at: input.at,
    note: input.note ?? null, merged_into: input.decision === 'merged' ? (input.merged_into ?? null) : null,
  };
}

/** The runbook row after `putVersion`, or the typed error. */
export function planPutVersion(runbook: Runbook | null, v: RunbookVersion, expectedCurrent: number, at: string): Runbook {
  if (!runbook) throw new NotFoundError(`runbook ${v.runbook_id}`);
  if (runbook.current_version !== expectedCurrent) {
    throw new VersionConflictError(`${runbook.id} is at v${runbook.current_version}, not v${expectedCurrent}`, expectedCurrent, runbook.current_version);
  }
  if (v.version !== expectedCurrent + 1) throw new InvalidWriteError(`${runbook.id} accepts v${expectedCurrent + 1}, not v${v.version}`);
  return { ...clone(runbook), current_version: v.version, updated_at: at };
}

export function checkCreate(runbook: Runbook, v1: RunbookVersion): void {
  if (v1.runbook_id !== runbook.id || v1.version !== 1 || runbook.current_version !== 1) {
    throw new InvalidWriteError('a new runbook starts at version 1 under its own id');
  }
}
export function checkPutRunbook(existing: Runbook | null, next: Runbook, expectedUpdatedAt: string): void {
  if (!existing) throw new NotFoundError(`runbook ${next.id}`);
  if (existing.updated_at !== expectedUpdatedAt) {
    throw new VersionConflictError(`${next.id} changed since it was read`, expectedUpdatedAt, existing.updated_at);
  }
  if (next.current_version !== existing.current_version) throw new InvalidWriteError('putRunbook cannot move current_version; use putVersion');
}
