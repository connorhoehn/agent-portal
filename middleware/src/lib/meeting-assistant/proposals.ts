// Proposals and the consent they need (docs/meeting-consent-design.md, "The consent rule").
//
// A proposal is consented only when ALL of these hold, judged here on the server:
//   1. two distinct people have consented;
//   2. every named person has consented;
//   3. the executor has consented;
//   4. no objection is open.
// Nobody is consented automatically: a proposal starts with no responses. Consent and objection can be withdrawn until it runs.
// An objection moves it to `objected`; withdrawing the last one re-evaluates (back to `open`, or straight to `consented`). "Not a
// decision" dismisses it. Nothing runs on a timer: expiry (end of call + 72 h) only ends it. Running it is a later package; this
// module only announces the move to `consented` (onProposalConsented).
//
// The rule itself is pure (`consentMet`, `settle`, `applyResponse`, `whatIsMissing`) so it is tested without a store. The service
// half (`createProposal`, `respondToProposal`, `listProposalsFor`, `closeProposals`) reads, applies the rule and writes back with the
// version it read, retrying when someone else wrote first, so two responses at once are both kept.
import { randomBytes } from 'node:crypto';
import { hashToolArgs } from '../voice/catalogue.js';
import type { AssistantStore } from './store.js';
import type { Proposal, ProposalOutcome, ProposalResponse, ProposalSource, ProposalState } from './types.js';

export const MAX_STATEMENT_CHARS = 280;
export const MAX_REASON_CHARS = 200;
export const MAX_NAMED = 10;
export const MAX_EVIDENCE = 40;
/** After the call ends a proposal waits this long on the meeting page, then expires unrun. */
export const PROPOSAL_AFTER_CALL_MS = 72 * 3600 * 1000;

/** States in which people may still answer: everything before running. */
export const ANSWERABLE: readonly ProposalState[] = ['open', 'objected', 'consented'];
export const FINISHED: readonly ProposalState[] = ['done', 'failed', 'dismissed', 'expired'];

export type ResponseKind = 'consent' | 'object' | 'withdraw' | 'not-a-decision';
export interface ResponseInput { userId: string; response: ResponseKind; reason?: string | null; at: number }

const consenters = (p: Pick<Proposal, 'responses'>): Set<string> => new Set(p.responses.filter((r) => r.response === 'consent').map((r) => r.userId));

/** The four conditions. True only when every one holds. */
export function consentMet(p: Pick<Proposal, 'responses' | 'named' | 'executor'>): boolean {
  const yes = consenters(p);
  if (yes.size < 2) return false;
  if (!p.named.every((u) => yes.has(u))) return false;
  if (!yes.has(p.executor)) return false;
  return !p.responses.some((r) => r.response === 'object');
}

/** Where an answerable proposal stands given its responses: an objection blocks, else the rule decides. */
export function settle(p: Pick<Proposal, 'responses' | 'named' | 'executor'>): 'open' | 'objected' | 'consented' {
  if (p.responses.some((r) => r.response === 'object')) return 'objected';
  return consentMet(p) ? 'consented' : 'open';
}

/** Who still has to consent (named people and the executor), and how many more consents of anyone the two-person rule needs after them. */
export function whatIsMissing(p: Pick<Proposal, 'responses' | 'named' | 'executor'>): { people: string[]; more: number; objectedBy: string[] } {
  const yes = consenters(p);
  const required = [...new Set([...p.named, p.executor])];
  const people = required.filter((u) => !yes.has(u));
  const more = Math.max(0, 2 - yes.size - people.length);
  return { people, more, objectedBy: p.responses.filter((r) => r.response === 'object').map((r) => r.userId) };
}

export type ApplyResult =
  | { ok: true; proposal: Proposal; changed: boolean }
  | { ok: false; why: 'finished' | 'reason-not-allowed' };

/**
 * One person's answer, applied to a copy. Answers are taken only while the proposal is open, objected or consented; one answer per
 * person (a new one replaces theirs); a withdrawal removes theirs (none to remove is no change). The state is settled again after.
 */
export function applyResponse(p: Proposal, input: ResponseInput): ApplyResult {
  if (!ANSWERABLE.includes(p.state)) return { ok: false, why: 'finished' };
  const reason = input.reason ?? null;
  if (reason !== null && input.response !== 'object') return { ok: false, why: 'reason-not-allowed' };
  const next: Proposal = { ...p, responses: p.responses.map((r) => ({ ...r })) };
  if (input.response === 'not-a-decision') {
    return { ok: true, changed: true, proposal: { ...next, state: 'dismissed', dismissedBy: input.userId, updatedAt: input.at } };
  }
  const mine = next.responses.findIndex((r) => r.userId === input.userId);
  if (input.response === 'withdraw') {
    if (mine < 0) return { ok: true, changed: false, proposal: p };
    next.responses.splice(mine, 1);
  } else {
    const entry: ProposalResponse = { userId: input.userId, response: input.response, reason: input.response === 'object' ? reason : null, at: input.at };
    const same = mine >= 0 && next.responses[mine]!.response === entry.response && next.responses[mine]!.reason === entry.reason;
    if (same) return { ok: true, changed: false, proposal: p };
    if (mine >= 0) next.responses.splice(mine, 1);
    next.responses.push(entry);
  }
  return { ok: true, changed: true, proposal: { ...next, state: settle(next), updatedAt: input.at } };
}

/** True when an unfinished proposal's time is up. A running one is the runner's to finish. */
export function isDue(p: Pick<Proposal, 'state' | 'expiresAt'>, nowMs: number): boolean {
  return ANSWERABLE.includes(p.state) && p.expiresAt !== null && p.expiresAt <= nowMs;
}

/** Validation errors carry a message the route answers with 400. */
export class ProposalInputError extends Error {}

const ID = /^[a-zA-Z0-9:_-]{1,128}$/;
const USER = /^[^\s\u0000-\u001f]{1,128}$/;
const TOOL = /^[a-zA-Z0-9_.-]{1,64}$/;
const MAX_ARGS_BYTES = 8192;

/** A reason: a string of one line, at most 200 characters, trimmed; empty is none. Throws ProposalInputError. */
export function cleanReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ProposalInputError('reason must be a string');
  if (/[\r\n\u2028\u2029]/.test(raw)) throw new ProposalInputError('reason must be one line');
  const t = raw.trim();
  if (t.length > MAX_REASON_CHARS) throw new ProposalInputError(`reason may be at most ${MAX_REASON_CHARS} characters`);
  return t || null;
}

export interface NewProposal {
  id?: string;
  callId: string;
  tenant: string;
  statement: string;
  outcome: ProposalOutcome;
  named: string[];
  executor: string;
  source: ProposalSource;
  evidence?: number[];
  at: number;
}

/** Check and build a new proposal. Responses start empty (nobody is consented automatically); the outcome is copied and digested. */
export function buildProposal(input: NewProposal): Proposal {
  const statement = typeof input.statement === 'string' ? input.statement.replace(/\s+/g, ' ').trim() : '';
  if (!statement || statement.length > MAX_STATEMENT_CHARS) throw new ProposalInputError(`statement is required (at most ${MAX_STATEMENT_CHARS} characters)`);
  const id = input.id ?? `p-${randomBytes(8).toString('hex')}`;
  if (typeof id !== 'string' || !ID.test(id)) throw new ProposalInputError('Invalid proposal id');
  if (typeof input.executor !== 'string' || !USER.test(input.executor)) throw new ProposalInputError('executor must be a user id');
  if (!Array.isArray(input.named) || input.named.length > MAX_NAMED || input.named.some((u) => typeof u !== 'string' || !USER.test(u))) throw new ProposalInputError(`named must be at most ${MAX_NAMED} user ids`);
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE || evidence.some((n) => !Number.isInteger(n) || n < 1)) throw new ProposalInputError(`evidence must be at most ${MAX_EVIDENCE} line numbers`);
  if (!['watcher', 'asked', 'dev'].includes(input.source)) throw new ProposalInputError('Invalid source');
  const outcome = cleanOutcome(input.outcome);
  return {
    id, callId: input.callId, tenant: input.tenant, statement, outcome, argsDigest: hashToolArgs(outcome),
    named: [...new Set(input.named)], executor: input.executor, source: input.source, evidence: [...new Set(evidence)].sort((a, b) => a - b),
    state: 'open', responses: [], dismissedBy: null, createdAt: input.at, updatedAt: input.at, expiresAt: null, version: 1,
  };
}

function cleanOutcome(raw: unknown): ProposalOutcome {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProposalInputError('outcome is required');
  const o = raw as Record<string, unknown>;
  if (o['kind'] === 'decision') {
    const initiativeId = o['initiativeId'] ?? null;
    if (initiativeId !== null && (typeof initiativeId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(initiativeId))) throw new ProposalInputError('Invalid initiativeId');
    return { kind: 'decision', initiativeId };
  }
  if (o['kind'] === 'tool') {
    if (typeof o['name'] !== 'string' || !TOOL.test(o['name'])) throw new ProposalInputError('outcome.name must be a tool name');
    let text: string;
    try { text = JSON.stringify(o['args'] ?? {}); } catch { throw new ProposalInputError('outcome.args must be JSON'); }
    if (Buffer.byteLength(text) > MAX_ARGS_BYTES) throw new ProposalInputError(`outcome.args may be at most ${MAX_ARGS_BYTES} bytes`);
    return { kind: 'tool', name: o['name'], args: JSON.parse(text) as unknown };
  }
  throw new ProposalInputError("outcome.kind must be 'decision' or 'tool'");
}

// ---- the hook the runner subscribes to -------------------------------------------------------------------------------------------

export type ConsentedListener = (proposal: Proposal) => void | Promise<void>;
const listeners = new Set<ConsentedListener>();

/** Called once each time a proposal moves INTO `consented` (after withdrawals it can happen again). Nothing runs here. Returns the unsubscriber. */
export function onProposalConsented(fn: ConsentedListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function announceConsented(p: Proposal): void {
  for (const fn of listeners) {
    // A listener's failure never undoes the response; only the id is logged, never the statement.
    Promise.resolve().then(() => fn(p)).catch((e: unknown) => console.warn('[meeting-assistant] a proposal listener failed', p.id, (e as Error).message));
  }
}

// ---- the service: read, apply, write back with the version read --------------------------------------------------------------------

/** The expiry a proposal of a call that has ended should carry. */
export const expiryAfter = (endedAt: number): number => endedAt + PROPOSAL_AFTER_CALL_MS;

export async function createProposal(store: AssistantStore, input: NewProposal): Promise<{ proposal: Proposal; created: boolean }> {
  return store.createProposal(buildProposal(input));
}

/** Give every proposal of the call its expiry (end + 72 h), once the call has ended. Safe to repeat. */
export async function closeProposals(store: AssistantStore, callId: string, endedAt: number): Promise<number> {
  return store.setProposalExpiry(callId, expiryAfter(endedAt));
}

const SAVE_ATTEMPTS = 8;

/** Move a due proposal to `expired` (conditional, so it is done once); the proposal as it stands after. */
async function expireIfDue(store: AssistantStore, p: Proposal, nowMs: number): Promise<Proposal> {
  let current: Proposal | null = p;
  for (let i = 0; i < SAVE_ATTEMPTS && current && isDue(current, nowMs); i += 1) {
    const saved = await store.saveProposal({ ...current, state: 'expired', updatedAt: nowMs }, current.version);
    if (saved) return saved;
    current = await store.getProposal(p.callId, p.id);
  }
  return current ?? p;
}

/** The call's proposals with any whose time is up moved to `expired`, and an expiry set on those of a call that ended (`endedAt`). */
export async function listProposalsFor(store: AssistantStore, callId: string, nowMs: number, endedAt: number | null): Promise<Proposal[]> {
  if (endedAt !== null) await closeProposals(store, callId, endedAt);
  const all = await store.listProposals(callId);
  return Promise.all(all.map((p) => expireIfDue(store, p, nowMs)));
}

export type RespondResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; why: 'not-found' | 'finished' | 'expired' | 'reason-not-allowed' | 'busy'; proposal?: Proposal };

/**
 * Apply one answer. Reads the proposal, expires it when its time is up, applies the rule and writes back naming the version read; when
 * another answer was written first it reads again and re-applies, so neither answer is lost.
 */
export async function respondToProposal(store: AssistantStore, callId: string, id: string, input: ResponseInput, endedAt: number | null = null): Promise<RespondResult> {
  if (endedAt !== null) await closeProposals(store, callId, endedAt);
  for (let i = 0; i < SAVE_ATTEMPTS; i += 1) {
    const read = await store.getProposal(callId, id);
    if (!read) return { ok: false, why: 'not-found' };
    const current = await expireIfDue(store, read, input.at);
    if (current.state === 'expired') return { ok: false, why: 'expired', proposal: current };
    const out = applyResponse(current, input);
    if (!out.ok) return { ok: false, why: out.why, proposal: current };
    if (!out.changed) return { ok: true, proposal: current };
    const saved = await store.saveProposal(out.proposal, current.version);
    if (!saved) continue; // someone else answered first: read again
    if (saved.state === 'consented' && current.state !== 'consented') announceConsented(saved);
    return { ok: true, proposal: saved };
  }
  return { ok: false, why: 'busy' };
}
