// Running a consented proposal (docs/meeting-consent-design.md, "Packages" item 3).
//
// When a proposal becomes `consented` the server moves it to `running` (a versioned save, so of two near-simultaneous final consents
// exactly one makes a turn) and makes ONE write turn for the executor's browser, as a confirmed action card's turn is made: the
// consent was the confirmation, so the turn starts `running` and has no card. The browser runs it like any confirmed write
// (portal MeetingTurnRunner, the same executor and exact-record rule).
//
//   decision outcome -> create { kind: 'decision' } on the call's initiative with the statement, the consenters as participants and
//                       the call id; `resolved` when the executor may decide on that initiative at that moment, else `waiting`.
//   tool outcome     -> that tool with the frozen arguments, only while their digest still matches the one people consented to.
//
// The executor's rights are checked when the turn is made and again when their browser claims it. When they may not run it, the
// proposal goes back to `consented` with a note naming them, and any consenter who can run it takes over by consenting again as
// executor (proposals.ts). A turn that expires (the browser was not there) also hands it back to `consented`, never `failed`. A
// result closes it: `done` with what was made (a decision's title and page, and whether it was recorded as decided or waiting), or
// `failed` with one plain sentence that says nothing was changed (`failedSentence`), never the browser's own error text.
//
// `runOutlook` answers the card's two questions before anyone consents: may this person run it, and will a decision be recorded as
// decided or as waiting for the initiative owner's decision.
//
// Nothing here speaks or posts in the call; the card reads the proposal. Statements, arguments and reasons are never logged.
import { randomBytes } from 'node:crypto';
import { CREATE_ACTIONS, hashToolArgs } from '../voice/catalogue.js';
import { MEETING_EXCLUDED_TOOLS, meetingTools } from './instructions.js';
import { announceProposalChanged } from './proposals.js';
import type { AssistantStore } from './store.js';
import type { AssistantRecord, AssistantTurn, Proposal, ProposalRun } from './types.js';

/** How long a proposal's turn waits for the executor's browser (the confirmed card's window). */
export const PROPOSAL_TURN_TTL_MS = 10 * 60_000;
export const PROPOSAL_NOTE_MAX = 200;
const SAVE_ATTEMPTS = 8;
/** At most this many participants on a decision record (the create tool's own limit). */
const MAX_PARTICIPANTS = 25;

export interface ProposalRunDeps {
  store: AssistantStore;
  now: () => number;
  /** The person's roles in the tenant (their grants). */
  rolesOf: (userId: string, tenant: string) => Promise<string[]>;
  /** May this role take this Cedar action (the create form's own gate)? */
  actionAllowed: (userId: string, role: string, tenant: string, action: string) => Promise<boolean>;
  /** May this person record a decision as decided on this initiative (lib/decision-authority.ts)? */
  mayDecide: (userId: string, tenant: string, initiativeId: string) => Promise<boolean>;
  nameOf: (userId: string) => Promise<string>;
}

const cap = (v: unknown, n: number): string => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const RECORD_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const consentersOf = (p: Proposal): string[] => p.responses.filter((r) => r.response === 'consent').sort((a, b) => a.at - b.at).map((r) => r.userId);

/** What the executor's browser runs, or why it cannot run at all (`failed`, nobody can fix it by consenting again). */
type Plan = { ok: true; name: string; args: Record<string, unknown> } | { ok: false; fail: string };

async function planOf(deps: ProposalRunDeps, p: Proposal, record: AssistantRecord): Promise<Plan> {
  if (p.outcome.kind === 'decision') {
    if (CREATE_ACTIONS[p.tenant]?.['decision'] === undefined) return { ok: false, fail: 'Decisions are not kept in this workspace, so it was not recorded.' };
    const initiativeId = p.outcome.initiativeId ?? record.initiativeId;
    if (!initiativeId) return { ok: false, fail: 'This call has no initiative to record the decision on.' };
    const resolved = await deps.mayDecide(p.executor, p.tenant, initiativeId).catch(() => false);
    return {
      ok: true, name: 'create',
      args: { kind: 'decision', fields: {
        // A typed ref: the browser's exact-record rule resolves it by id, never by a name.
        initiative: `initiative:${initiativeId}`, statement: p.statement, state: resolved ? 'resolved' : 'waiting',
        participants: consentersOf(p).slice(0, MAX_PARTICIPANTS), call: p.callId,
      } },
    };
  }
  // The arguments run only as people consented to them.
  if (hashToolArgs(p.outcome) !== p.argsDigest) return { ok: false, fail: 'The action changed after people consented, so it was not run.' };
  const args = p.outcome.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, fail: 'The action has no arguments to run.' };
  return { ok: true, name: p.outcome.name, args: args as Record<string, unknown> };
}

/** Whether `userId` may run this write now: the tool is in one of their roles' meeting catalogue, and a create's kind passes its form's gate. */
export async function mayRun(deps: ProposalRunDeps, userId: string, tenant: string, name: string, args: unknown): Promise<boolean> {
  if (MEETING_EXCLUDED_TOOLS.has(name)) return false;
  const kind = name === 'create' && args && typeof args === 'object' ? (args as Record<string, unknown>)['kind'] : undefined;
  const roles = await deps.rolesOf(userId, tenant).catch(() => [] as string[]);
  for (const role of roles) {
    if (!meetingTools(tenant, role).some((t) => t.name === name)) continue;
    if (name === 'create') {
      const action = typeof kind === 'string' ? CREATE_ACTIONS[tenant]?.[kind] : undefined;
      if (action === undefined) continue;
      if (action !== null && !await deps.actionAllowed(userId, role, tenant, action).catch(() => false)) continue;
    }
    return true;
  }
  return false;
}

const run = (by: string, at: number, over: Partial<ProposalRun> = {}): ProposalRun => ({ turnId: null, by, at, title: null, href: null, note: null, ...over });

/** Save `change(p)` on the version read, reading again when someone else wrote first; stops when `change` returns null. */
async function saveWith(deps: ProposalRunDeps, callId: string, id: string, change: (p: Proposal) => Proposal | null): Promise<Proposal | null> {
  for (let i = 0; i < SAVE_ATTEMPTS; i += 1) {
    const p = await deps.store.getProposal(callId, id);
    if (!p) return null;
    const next = change(p);
    if (!next) return null;
    const saved = await save(deps, next, p.version);
    if (saved) return saved;
  }
  return null;
}

/** Every save here is announced, so the call chat's card moves with running, done, failed and a hand-back. */
async function save(deps: ProposalRunDeps, next: Proposal, version: number): Promise<Proposal | null> {
  const saved = await deps.store.saveProposal(next, version);
  if (saved) await announceProposalChanged(saved);
  return saved;
}

/**
 * Why the executor's browser will not run it, and who could: the other consenters who may run the same write now. The card shows
 * it; one of them takes over by consenting again as executor. With nobody, it stays consented (and in the minutes) until it expires.
 */
export async function cannotRunNote(deps: ProposalRunDeps, p: Proposal, name: string, args: unknown): Promise<string> {
  const who = await deps.nameOf(p.executor);
  const others: string[] = [];
  for (const userId of consentersOf(p)) {
    if (userId === p.executor || others.length >= 3) continue;
    if (await mayRun(deps, userId, p.tenant, name, args)) others.push(await deps.nameOf(userId));
  }
  if (!others.length) return `${who} cannot run this, and nobody who consented can. Someone else who can may consent and run it.`;
  const list = others.length === 1 ? others[0]! : `${others.slice(0, -1).join(', ')} or ${others[others.length - 1]!}`;
  return `${who} cannot run this. ${list} can run it instead.`;
}

/**
 * A proposal just became `consented` (or was taken over): move it to `running` and make the executor's one turn, or say why not.
 * Returns the turn made, or null (not consented any more, someone else started it, or it cannot run).
 */
export async function startProposal(deps: ProposalRunDeps, callId: string, id: string): Promise<AssistantTurn | null> {
  for (let i = 0; i < SAVE_ATTEMPTS; i += 1) {
    const p = await deps.store.getProposal(callId, id);
    if (!p || p.state !== 'consented') return null;
    const record = await deps.store.get(callId);
    if (!record) return null;
    const now = deps.now();
    const plan = await planOf(deps, p, record);
    if (!plan.ok) {
      if (await save(deps, { ...p, state: 'failed', run: run(p.executor, now, { note: plan.fail }), updatedAt: now }, p.version)) return null;
      continue;
    }
    if (!await mayRun(deps, p.executor, p.tenant, plan.name, plan.args)) {
      const note = await cannotRunNote(deps, p, plan.name, plan.args);
      if (p.run && p.run.turnId === null && p.run.by === p.executor && p.run.note === note) return null;
      if (await save(deps, { ...p, run: run(p.executor, now, { note }), updatedAt: now }, p.version)) return null;
      continue;
    }
    const turnId = `t-p${randomBytes(5).toString('hex')}`;
    const started = await save(deps, { ...p, state: 'running', run: run(p.executor, now, { turnId }), updatedAt: now }, p.version);
    if (!started) continue; // another consent or a second announcement wrote first: read again (it is running then, and we stop)
    const turn: AssistantTurn = {
      turnId, callId, askedBy: p.executor, tool: { name: plan.name, args: plan.args }, kind: 'write', status: 'running', proposalId: p.id,
      createdAt: now, expiresAt: now + PROPOSAL_TURN_TTL_MS,
    };
    try {
      return (await deps.store.createTurn(turn)).turn;
    } catch (e) {
      console.warn('[meeting-assistant] a proposal turn could not be made', p.id, (e as Error).message);
      await handBack(deps, callId, id, turnId, 'Nova could not start this. Nothing was changed, and it can be run again.');
      return null;
    }
  }
  return null;
}

/** Put a running proposal whose turn is `turnId` back to `consented` with a note. Nothing when it moved on or is gone. */
export async function handBack(deps: ProposalRunDeps, callId: string, id: string, turnId: string, note: string): Promise<Proposal | null> {
  const now = deps.now();
  return saveWith(deps, callId, id, (p) => (p.state === 'running' && p.run?.turnId === turnId
    ? { ...p, state: 'consented', run: run(p.executor, now, { note: cap(note, PROPOSAL_NOTE_MAX) }), updatedAt: now } : null));
}

export type ClaimCheck = { ok: true } | { ok: false; why: 'gone' | 'not-allowed' };

/**
 * The executor's browser is about to claim a proposal's turn: the proposal is still running this turn, and the executor may still run
 * it (a decision recorded as decided needs the decide rule still). When not, the proposal goes back to `consented` with a note.
 */
export async function checkBeforeClaim(deps: ProposalRunDeps, turn: AssistantTurn): Promise<ClaimCheck> {
  const p = turn.proposalId ? await deps.store.getProposal(turn.callId, turn.proposalId) : null;
  if (!p || p.state !== 'running' || p.run?.turnId !== turn.turnId || p.executor !== turn.askedBy) return { ok: false, why: 'gone' };
  let allowed = await mayRun(deps, turn.askedBy, p.tenant, turn.tool.name, turn.tool.args);
  const fields = (turn.tool.args as { fields?: { state?: unknown; initiative?: unknown } } | null)?.fields;
  if (allowed && turn.tool.name === 'create' && fields?.state === 'resolved') {
    const initiativeId = typeof fields.initiative === 'string' ? fields.initiative.replace(/^initiative:/, '') : '';
    allowed = !!initiativeId && await deps.mayDecide(turn.askedBy, p.tenant, initiativeId).catch(() => false);
  }
  if (allowed) return { ok: true };
  await handBack(deps, turn.callId, p.id, turn.turnId, await cannotRunNote(deps, p, turn.tool.name, turn.tool.args));
  return { ok: false, why: 'not-allowed' };
}

/**
 * A failed run as one plain sentence that says nothing was changed (a write that fails changes nothing), never the browser's own
 * error text: what was gone, who was not allowed, what changed since, or that Nova could not carry it out.
 */
export function failedSentence(error: string | undefined, p: Pick<Proposal, 'outcome'>, executorName: string): string {
  const e = (error ?? '').toLowerCase();
  const thing = p.outcome.kind === 'decision' ? 'The initiative' : p.outcome.name === 'update' ? 'The record it changes' : 'Something it needed';
  if (/not found|no such|deleted|\b404\b|does not exist|gone/.test(e)) return `${thing} was deleted or moved since, so nothing was changed.`;
  if (/forbidden|not allowed|permission|denied|unauthori[sz]ed|\b403\b|\b401\b/.test(e)) return `${executorName} was not allowed to do this, so nothing was changed.`;
  if (/conflict|\b409\b|version|changed since|stale/.test(e)) return 'The record changed since people consented, so nothing was changed.';
  return 'Nova could not carry this out, so nothing was changed.';
}

/** The executor's browser posted the turn's result (already accepted on the turn): close the proposal as done or failed. */
export async function finishProposal(deps: ProposalRunDeps, turn: AssistantTurn, result: { ok: boolean; output?: unknown; error?: string }): Promise<Proposal | null> {
  if (!turn.proposalId) return null;
  const now = deps.now();
  const out = (result.output && typeof result.output === 'object' ? result.output : {}) as Record<string, unknown>;
  const executorName = result.ok ? '' : await deps.nameOf(turn.askedBy).catch(() => 'The person running it');
  // A decision record says how it was made: decided, or waiting for the initiative owner's decision.
  const fields = (turn.tool.args as { fields?: { state?: unknown } } | null)?.fields;
  const recordedAs = fields?.state === 'resolved' ? 'decided' as const : fields?.state === 'waiting' ? 'waiting' as const : null;
  return saveWith(deps, turn.callId, turn.proposalId, (p) => {
    if (p.state !== 'running' || p.run?.turnId !== turn.turnId) return null;
    if (!result.ok) return { ...p, state: 'failed', run: run(p.executor, now, { turnId: turn.turnId, note: failedSentence(result.error, p, executorName) }), updatedAt: now };
    // A decision is titled by its statement and linked by the id the route answered; the browser's own words are not trusted for a link.
    const recordId = typeof out['id'] === 'string' && RECORD_ID.test(out['id']) ? out['id'] : null;
    const decision = p.outcome.kind === 'decision';
    const title = decision ? p.statement : (cap(out['say'], PROPOSAL_NOTE_MAX) || 'Done.');
    const href = decision && recordId ? `/iq/decisions/${encodeURIComponent(recordId)}` : null;
    return { ...p, state: 'done', run: run(p.executor, now, { turnId: turn.turnId, title, href, ...(decision && recordedAs ? { recordedAs } : {}) }), updatedAt: now };
  });
}

/** A proposal's turn expired: back to `consented`, so the executor or another consenter can run it. Claimed with no result, it may have run. */
export async function expireProposalTurn(deps: ProposalRunDeps, turn: AssistantTurn): Promise<Proposal | null> {
  if (!turn.proposalId) return null;
  const name = await deps.nameOf(turn.askedBy);
  const note = turn.claimId !== undefined
    ? 'Nova could not confirm whether this was done. Check before running it again.'
    : `${name} was not there to run this. ${name} can run it now, or another consenter can.`;
  return handBack(deps, turn.callId, turn.proposalId, turn.turnId, note);
}

/** Before it runs: whether a decision outcome will be recorded as decided by `executor`, or as waiting for the owner's decision. */
export async function decisionRecordedAs(deps: Pick<ProposalRunDeps, 'mayDecide'>, p: Proposal, initiativeId: string | null): Promise<'decided' | 'waiting' | null> {
  if (p.outcome.kind !== 'decision') return null;
  const id = p.outcome.initiativeId ?? initiativeId;
  if (!id) return null;
  return (await deps.mayDecide(p.executor, p.tenant, id).catch(() => false)) ? 'decided' : 'waiting';
}

/**
 * Whether `userId` may run this proposal's write now (the plan's tool under their roles): `yes`, `no`, or `never` when it cannot run
 * at all (no initiative, decisions not kept here, the action changed): the executor's click then ends it as failed, with the reason.
 */
export async function mayRunProposal(deps: ProposalRunDeps, p: Proposal, record: AssistantRecord, userId: string): Promise<'yes' | 'no' | 'never'> {
  const plan = await planOf({ ...deps, mayDecide: async () => false }, p, record);
  if (!plan.ok) return 'never';
  return (await mayRun(deps, userId, p.tenant, plan.name, plan.args)) ? 'yes' : 'no';
}
