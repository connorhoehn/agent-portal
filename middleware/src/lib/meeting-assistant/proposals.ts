// Proposals and the consent they need (docs/meeting-consent-design.md, "The consent rule").
//
// A proposal is consented only when ALL of these hold, judged here on the server:
//   1. two distinct people have consented;
//   2. every named person has consented;
//   3. the executor has consented;
//   4. no objection is open.
// Nobody is consented automatically: a proposal starts with no responses. Consent and objection can be withdrawn until it runs.
// An objection moves it to `objected`; withdrawing the last one re-evaluates (back to `open`, or straight to `consented`). "Not a
// decision" dismisses it. Nothing runs on a timer: expiry (end of call + 72 h) only ends it. This module announces the move to
// `consented` (onProposalConsented); proposal-run.ts runs it in the executor's browser.
//
// The executor's click is the last step (the design's condition 3). When the executor's own consent is the one that meets the rule, it
// runs at once. When someone else's consent (or a withdrawn objection) meets it, it stops at `consented` and the executor is asked
// "Ready: run it now"; only their click (a consent `asExecutor`) starts it.
//
// Taking over: while it is `consented` (its executor may not run it, or was not there), another person may consent AS EXECUTOR. They
// become the executor and it is announced, so the runner tries for them. The route lets only people the server says can run it do
// so (`you.canRun`): a consenter, or, when nobody who consented can run it, someone who has not answered (their click is a consent
// too). The rule is unchanged by it: every condition still holds, and the new executor's click is the last step.
//
// "Not a decision" (dismiss): on a proposal Milo raised from what it heard, anyone seated; on one a person asked for, only the asker
// ("Drop it"). The person who dismissed it may reopen it (`reopen`), unless it was raised again. "Raise it again" (`raiseAgain`)
// closes an objected or failed proposal and opens a new one with the same outcome; earlier answers do not carry.
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

export type ResponseKind = 'consent' | 'object' | 'withdraw' | 'not-a-decision' | 'reopen';
export interface ResponseInput {
  userId: string; response: ResponseKind; reason?: string | null; at: number;
  /** With `consent` only, while the proposal is `consented`: run it now, in my browser (the executor's own click, or a take-over the route allowed). */
  asExecutor?: boolean;
  /** With `asExecutor`, by someone who has not answered: the route found that nobody who consented can run it and they can. */
  mayJoin?: boolean;
}

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
  | { ok: false; why: 'finished' | 'reason-not-allowed' | 'not-consented' | 'not-a-consenter' | 'not-allowed' };

/** Who may dismiss: anyone seated on a proposal Milo raised by itself; only the asker on one a person asked for. */
export const mayDismiss = (p: Pick<Proposal, 'source' | 'askedBy' | 'executor'>, userId: string): boolean =>
  p.source !== 'asked' || userId === (p.askedBy ?? p.executor);
/** Who may undo a dismissal: the person who dismissed it, unless it was closed because someone raised it again. */
export const mayReopen = (p: Pick<Proposal, 'state' | 'dismissedBy' | 'run'>, userId: string): boolean =>
  p.state === 'dismissed' && p.dismissedBy === userId && !p.run?.raisedAs;

/**
 * One person's answer, applied to a copy. Answers are taken only while the proposal is open, objected or consented; one answer per
 * person (a new one replaces theirs); a withdrawal removes theirs (none to remove is no change). The state is settled again after.
 */
export function applyResponse(p: Proposal, input: ResponseInput): ApplyResult {
  if (input.response === 'reopen') {
    if (!mayReopen(p, input.userId)) return { ok: false, why: p.state === 'dismissed' ? 'not-allowed' : 'finished' };
    const back: Proposal = { ...p, responses: p.responses.map((r) => ({ ...r })), dismissedBy: null, updatedAt: input.at };
    return { ok: true, changed: true, proposal: { ...back, state: settle(back) } };
  }
  if (!ANSWERABLE.includes(p.state)) return { ok: false, why: 'finished' };
  const reason = input.reason ?? null;
  if (reason !== null && input.response !== 'object') return { ok: false, why: 'reason-not-allowed' };
  const next: Proposal = { ...p, responses: p.responses.map((r) => ({ ...r })) };
  if (input.asExecutor) {
    // Only once it is consented: nobody becomes executor of something not agreed. Someone who had not answered consents by this
    // click (the route allows that only when nobody who consented can run it); an objector must withdraw first.
    if (input.response !== 'consent') return { ok: false, why: 'reason-not-allowed' };
    if (p.state !== 'consented') return { ok: false, why: 'not-consented' };
    const had = consenters(p).has(input.userId);
    if (!had && (!input.mayJoin || p.responses.some((r) => r.userId === input.userId))) return { ok: false, why: 'not-a-consenter' };
    const responses = had ? next.responses.map((r) => (r.userId === input.userId ? { ...r, at: input.at } : r))
      : [...next.responses, { userId: input.userId, response: 'consent' as const, reason: null, at: input.at }];
    return { ok: true, changed: true, proposal: { ...next, responses, executor: input.userId, state: 'consented', updatedAt: input.at } };
  }
  if (input.response === 'not-a-decision') {
    if (!mayDismiss(p, input.userId)) return { ok: false, why: 'not-allowed' };
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
  /** The person who asked Milo for it (an asked write). */
  askedBy?: string | null;
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
  const askedBy = input.askedBy ?? null;
  if (askedBy !== null && (typeof askedBy !== 'string' || !USER.test(askedBy))) throw new ProposalInputError('askedBy must be a user id');
  const outcome = cleanOutcome(input.outcome);
  return {
    id, callId: input.callId, tenant: input.tenant, statement, outcome, argsDigest: hashToolArgs(outcome),
    named: [...new Set(input.named)], executor: input.executor, source: input.source, evidence: [...new Set(evidence)].sort((a, b) => a - b),
    state: 'open', responses: [], dismissedBy: null, createdAt: input.at, updatedAt: input.at, expiresAt: null, version: 1, run: null, askedBy,
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

/** Called once each time a proposal moves INTO `consented` (after withdrawals it can happen again) and on each take-over. Nothing runs here. Returns the unsubscriber. */
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

/**
 * Called after a proposal is created or saved with a change (an answer, a dismissal, an expiry), whatever made it. The call chat's
 * proposal card follows through this (chat.ts). Awaited so the card is in place when the route answers; a listener's failure is
 * logged by id and never undoes the write.
 */
export type ChangedListener = (proposal: Proposal, how: 'created' | 'changed') => void | Promise<void>;
const changedListeners = new Set<ChangedListener>();
export function onProposalChanged(fn: ChangedListener): () => void {
  changedListeners.add(fn);
  return () => { changedListeners.delete(fn); };
}
async function announceChanged(p: Proposal, how: 'created' | 'changed'): Promise<void> {
  for (const fn of changedListeners) {
    try { await fn(p, how); } catch (e) { console.warn('[meeting-assistant] a proposal change listener failed', p.id, (e as Error).message); }
  }
}

/** A save made elsewhere (the runner: running, done, failed, handed back) is announced the same way, so the card follows it. */
export async function announceProposalChanged(p: Proposal): Promise<void> { await announceChanged(p, 'changed'); }

// ---- the service: read, apply, write back with the version read --------------------------------------------------------------------

/** The expiry a proposal of a call that has ended should carry. */
export const expiryAfter = (endedAt: number): number => endedAt + PROPOSAL_AFTER_CALL_MS;

export async function createProposal(store: AssistantStore, input: NewProposal): Promise<{ proposal: Proposal; created: boolean }> {
  const out = await store.createProposal(buildProposal(input));
  if (out.created) await announceChanged(out.proposal, 'created');
  return out;
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
    if (saved) { await announceChanged(saved, 'changed'); return saved; }
    current = await store.getProposal(p.callId, p.id);
  }
  return current ?? p;
}

/**
 * The retention sweep's step: every proposal whose 72 hours after the call are up is moved to `expired` (and its card follows).
 * Nothing runs: expiry only ends it. Returns how many expired.
 */
export async function expireDueProposals(store: AssistantStore, nowMs: number, limit = 200): Promise<number> {
  let expired = 0;
  for (const p of await store.dueProposals(nowMs, limit)) if ((await expireIfDue(store, p, nowMs)).state === 'expired') expired += 1;
  return expired;
}

/** The call's proposals with any whose time is up moved to `expired`, and an expiry set on those of a call that ended (`endedAt`). */
export async function listProposalsFor(store: AssistantStore, callId: string, nowMs: number, endedAt: number | null): Promise<Proposal[]> {
  if (endedAt !== null) await closeProposals(store, callId, endedAt);
  const all = await store.listProposals(callId);
  return Promise.all(all.map((p) => expireIfDue(store, p, nowMs)));
}

export type RespondResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; why: 'not-found' | 'finished' | 'expired' | 'reason-not-allowed' | 'not-consented' | 'not-a-consenter' | 'not-allowed' | 'busy'; proposal?: Proposal };

/**
 * Whether this saved answer starts the run: the executor's own click is the last step. A consent `asExecutor` (run it now, or a
 * take-over) always does; an ordinary consent does when it is the executor's and it is the one that met the rule. Anyone else's
 * consent, or a withdrawn objection, leaves it `consented` for the executor to start.
 */
export function startsRun(before: Pick<Proposal, 'state'>, after: Pick<Proposal, 'state' | 'executor'>, input: Pick<ResponseInput, 'userId' | 'response' | 'asExecutor'>): boolean {
  if (after.state !== 'consented') return false;
  if (input.asExecutor) return true;
  return before.state !== 'consented' && input.response === 'consent' && input.userId === after.executor;
}

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
    if (startsRun(current, saved, input)) announceConsented(saved);
    await announceChanged(saved, 'changed');
    return { ok: true, proposal: saved };
  }
  return { ok: false, why: 'busy' };
}

export type RaiseResult =
  | { ok: true; proposal: Proposal; closed: Proposal }
  | { ok: false; why: 'not-found' | 'not-raisable' | 'cap' | 'busy'; proposal?: Proposal };

/** Only a blocked or failed proposal is raised again, and only once. */
export const mayRaiseAgain = (p: Pick<Proposal, 'state' | 'run'>): boolean => (p.state === 'objected' || p.state === 'failed') && !p.run?.raisedAs;

/**
 * "Raise it again" (the design's way past an objection, and the next step after a failed run): a NEW open proposal with the same
 * statement, outcome, named people, executor, source, asker and evidence, with no answers (earlier consents do not carry). The old one
 * is closed first, by a versioned save, so of two people raising it at once exactly one new proposal is made: an objected one moves
 * to `dismissed` (by the raiser), a failed one stays failed; both carry the new id (`run.raisedAs`). A raised copy counts toward the
 * call's cap for its source (`cap`), as the watcher's own proposals do.
 */
export async function raiseAgain(store: AssistantStore, callId: string, id: string, userId: string, at: number, cap: number): Promise<RaiseResult> {
  const newId = `p-${randomBytes(8).toString('hex')}`;
  for (let i = 0; i < SAVE_ATTEMPTS; i += 1) {
    const read = await store.getProposal(callId, id);
    if (!read) return { ok: false, why: 'not-found' };
    const p = await expireIfDue(store, read, at);
    if (!mayRaiseAgain(p)) return { ok: false, why: 'not-raisable', proposal: p };
    if ((await store.listProposals(callId)).filter((x) => x.source === p.source).length >= cap) return { ok: false, why: 'cap', proposal: p };
    const note = 'Raised again as a new proposal.';
    // A failed run keeps whose it was and why; an objected one is closed by the person who raised it again.
    const run = p.state === 'failed' && p.run ? { ...p.run, raisedAs: newId } : { turnId: null, title: null, href: null, by: userId, at, note, raisedAs: newId };
    const closed = await store.saveProposal(p.state === 'objected' ? { ...p, state: 'dismissed', dismissedBy: userId, run, updatedAt: at } : { ...p, run, updatedAt: at }, p.version);
    if (!closed) continue;
    await announceChanged(closed, 'changed');
    const { proposal } = await createProposal(store, {
      id: newId, callId, tenant: p.tenant, statement: p.statement, outcome: p.outcome, named: p.named, executor: p.executor, source: p.source,
      askedBy: p.askedBy ?? null, evidence: p.evidence, at,
    });
    return { ok: true, proposal, closed };
  }
  return { ok: false, why: 'busy' };
}
