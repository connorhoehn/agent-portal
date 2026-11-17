// The meeting assistant's store: ONE interface, two implementations, the run-report store's rule
// (lib/run-reports/store.ts). MemoryAssistantStore (below, the mock default) and SqlAssistantStore
// (store-sql.ts, schema/meeting_assistant_schema.sql). The shared contract suite
// (__tests__/store.test.ts) runs the memory store; the SQL store is covered by tests of its
// statements (__tests__/store-sql.test.ts) because no database runs in unit tests.
//
// What the interface guarantees:
//  * One record per call. `create` on an existing call returns what is there, `created: false`.
//  * `appendLine` stores a line only while the state is `listening`, assigns the next `seq` and
//    bumps `linesStored` in one step, and stores a repeated `captionId` once (returns null).
//  * Reads return copies. `left` ends a period, not the record: `rejoin` moves it back to `listening` once, only from the leave the
//    caller read (its `leftAt`), so two invitations back at once make one new period.
//  * An action is created once per (call, actionId); `decideAction` moves it only from the statuses
//    named in `from` and returns null otherwise, so two clicks decide once. A turn (a tool call waiting on the asker's
//    browser) is the same: created once per (call, turnId), `moveTurn` moves it only from the statuses named.
//  * A proposal is created once per (call, id). `saveProposal` writes only when the stored version is the one the caller
//    read, so of two responses at once one wins and the other reads again (lib/meeting-assistant/proposals.ts retries).
//    Its statement, outcome, digest, named people and executor are never rewritten.
import type { AssistantAction, AssistantRecord, MinutesActionItem, MinutesRecord, AssistantSession, AssistantState, AssistantTurn, PendingRequest, Proposal, TranscriptLine, TurnStatus } from './types.js';
import { periodOf, sessionOf } from './types.js';
import { WRITE_FINISH_MS } from './limits.js';

export const MAX_PENDING_REQUESTS = 20;
export const MAX_LINE_CHARS = 2000;
/** What a delete leaves in place of a turn's tool arguments and an action's result text: ids, statuses and times stay, words go. */
export const REMOVED_BY_INVITER = 'Removed by the inviter';

export interface StateChange {
  /** The states this change may start from; anything else leaves the record alone and returns null. */
  from: readonly AssistantState[];
  to: AssistantState;
  by: string;
  at: number;
}

/** Milo is invited back into a call it left (`rejoin`): the person, the moment, who is seated now, and the session bookkeeping to write with it. */
export interface RejoinChange {
  /** The leave the caller read: the record must still be `left` from exactly this moment, or nothing changes. */
  leftAt: number;
  by: string;
  at: number;
  /** Seat holders now: they owe a new acknowledgement (all but `by`) and become attendees. */
  present: readonly string[];
  /** Merged over the stored session: the new period's money and clock, and the closed period appended to `periods`. */
  session: Partial<AssistantSession>;
}

/**
 * What a later period adds to minutes that already hold a draft (`appendMinutes`). The new decisions, action items and topics go AFTER
 * the stored ones, which stay unchanged and in place (an index names an item: its card, its work item, its `done`).
 */
export interface MinutesAddition {
  /** The whole call's summary now; null keeps the stored one (nothing new was heard). */
  summary: string | null;
  decisions: string[];
  actionItems: MinutesActionItem[];
  topics: string[];
  endedAt: number;
  /** Unioned with the stored attendees. */
  attendees: string[];
  lineCount: number;
  throughSeq: number;
  truncated: boolean;
  /** A real addition: `additions` is counted, the bell may ring again (`notifiedAt` cleared) and any owed addition is settled. */
  added: boolean;
}

export interface ActionChange {
  from: readonly AssistantAction['status'][];
  to: AssistantAction['status'];
  by: string;
  at: number;
  resultText?: string;
}

export interface TurnChange {
  from: readonly TurnStatus[];
  to: TurnStatus;
  actionId?: string;
}

export interface TurnFilter { askedBy?: string; statuses?: readonly TurnStatus[] }

export interface AssistantStore {
  get(callId: string): Promise<AssistantRecord | null>;
  create(record: AssistantRecord): Promise<{ record: AssistantRecord; created: boolean }>;
  transition(callId: string, change: StateChange): Promise<AssistantRecord | null>;
  /**
   * left -> listening, only while the record is `left` from `change.leftAt`: `invitedBy` becomes `by`, the leave and the pause are
   * cleared, `acked` is just `by`, `presentAtInvite` is `present`, `attendees` gains them, the voice goes off, and `session` is merged
   * in. `invitedAt` stays (the meeting's start). Null when the record moved on (another rejoin won, or it is gone), and when the call's
   * words were erased (its minutes are a tombstone): checked in the same step, so a delete racing an invitation back never leaves a
   * deleted record listening.
   */
  rejoin(callId: string, change: RejoinChange): Promise<AssistantRecord | null>;
  /** Record that `userId` acknowledged the transcription notice (idempotent); null when there is no record. */
  ack(callId: string, userId: string): Promise<AssistantRecord | null>;
  /** Record that `userId` held an ACTIVE seat while the assistant was in the call (idempotent; ignored once the assistant has left, audit M1). */
  attend(callId: string, userId: string): Promise<void>;
  appendLine(line: Omit<TranscriptLine, 'seq'>): Promise<TranscriptLine | null>;
  addRequest(callId: string, request: PendingRequest): Promise<void>;
  lines(callId: string, after: number, limit: number): Promise<TranscriptLine[]>;
  /** Record an action card; an existing (call, actionId) is returned as it is with `created: false`. */
  createAction(action: AssistantAction): Promise<{ action: AssistantAction; created: boolean }>;
  getAction(callId: string, actionId: string): Promise<AssistantAction | null>;
  /** Move an action; null when it is unknown or not in one of `change.from`. */
  decideAction(callId: string, actionId: string, change: ActionChange): Promise<AssistantAction | null>;
  /** Turn Milo's voice on or off for the call; the record, or null when there is none. */
  setVoice(callId: string, on: boolean): Promise<AssistantRecord | null>;
  /**
   * Merge fields into the record's session bookkeeping; null when there is no record. With `when.period`, only while the record is still
   * in that period (`periodOf`), in the same step: a run of an earlier period that stops late never changes the newer one (null then).
   */
  patchSession(callId: string, patch: Partial<AssistantSession>, when?: { period?: number }): Promise<AssistantRecord | null>;
  /** Add one to the refused-call counter; the new count, or 0 when there is no record. */
  bumpRefused(callId: string): Promise<number>;
  /** Record a turn; an existing (call, turnId) is returned as it is with `created: false`. */
  createTurn(turn: AssistantTurn): Promise<{ turn: AssistantTurn; created: boolean }>;
  getTurn(callId: string, turnId: string): Promise<AssistantTurn | null>;
  listTurns(callId: string, filter?: TurnFilter): Promise<AssistantTurn[]>;
  /**
   * Claim a turn for one browser, in ONE conditional step: the turn is runnable (a read `pending`, a write `running`), not past
   * `nowMs`, and not claimed yet. Null otherwise, so of two simultaneous claims exactly one wins (audit B6).
   */
  claimTurn(callId: string, turnId: string, claim: { claimId: string; claimedAt: number }, nowMs: number): Promise<AssistantTurn | null>;
  /** Turns in any call still `pending` or `running` whose time is up at `nowMs`, oldest first, at most `limit` (the expiry sweep, audit M9). */
  dueTurns(nowMs: number, limit: number): Promise<AssistantTurn[]>;
  /** Move a turn; null when it is unknown or not in one of `change.from` (two results settle once). */
  moveTurn(callId: string, turnId: string, change: TurnChange): Promise<AssistantTurn | null>;
  /** Delete lines at or before `cutoffMs` (epoch), except the lines of a call that is still `listening` or `paused`. Returns how many went. */
  sweepLines(cutoffMs: number): Promise<number>;
  /**
   * Calls whose age is at or before `cutoffMs` (`leftAt` when set, else `invitedAt`) and that are not `listening` or `paused`, oldest
   * first, at most `limit`: what the retention sweep removes whole (audit M3).
   */
  expiredCalls(cutoffMs: number, limit: number): Promise<AssistantRecord[]>;
  /** Delete everything stored for the call: lines, minutes or tombstone, turns, actions and the record. Refuses (false) a call that is `listening` or `paused`, or unknown. */
  purgeCall(callId: string): Promise<boolean>;
  /** Records in any of `states`, oldest invite first, at most `limit` (the boot reconcile, audit M5). */
  listByState(states: readonly AssistantState[], limit: number): Promise<AssistantRecord[]>;
  /** Records of one call lobby, oldest invite first, at most `limit` (an interview's calls, for its retention: lib/interviews/retention). */
  callsOfLobby(lobby: string, limit: number): Promise<AssistantRecord[]>;
  /** The call's minutes, or its tombstone (`deleted` set); null when none were written. */
  getMinutes(callId: string): Promise<MinutesRecord | null>;
  /** Write the call's minutes once; an existing row (minutes or tombstone) is returned with `created: false`. */
  putMinutes(minutes: MinutesRecord): Promise<{ minutes: MinutesRecord; created: boolean }>;
  /** Live minutes (not tombstones) for calls `userId` attended in `tenant`, newest `endedAt` first, strictly before `before` when given. */
  listMinutes(filter: MinutesFilter): Promise<MinutesRecord[]>;
  /**
   * Delete the call's lines and replace its minutes with a tombstone (created when none exist), so they are not written again; the record
   * is marked (`session.erasedAt`) so it is never joined again. Returns the lines removed, or null, with nothing touched, while Milo is in
   * the call (`listening` or `paused`: it was invited back): the check is part of the same step.
   */
  tombstoneMinutes(callId: string, by: string, at: number): Promise<number | null>;
  /** Count one more writer run for minutes that have no draft yet, only when `attempts` is still `expect` and below `max` (one run at a time, a hard cap). True when counted. */
  claimMinutesAttempt(callId: string, expect: number, max: number): Promise<boolean>;
  /** Replace the content of minutes that have no draft (writer 'none', not deleted) with a new write; `attempts` and `notifiedAt` are kept. True when replaced. */
  rewriteMinutes(minutes: MinutesRecord): Promise<boolean>;
  /**
   * Minutes that may be written again, oldest first: without a draft with fewer than `maxAttempts` runs, or owing an addition with fewer
   * than `maxAttempts` runs of that addition.
   */
  listRetryableMinutes(maxAttempts: number, limit: number): Promise<MinutesRecord[]>;
  /**
   * Add a later period to minutes that hold a draft (writer not 'none', not deleted), only when the stored `throughSeq` is still
   * `expectThroughSeq` (null: none stored yet, an older record). The stored decisions, action items and topics stay in place and the
   * new ones follow them; attendees are unioned. With `added`, `additions` counts one more, `notifiedAt` is cleared and an owed addition
   * is settled. Returns the stored minutes, or null when they moved on (another addition won) or are not there.
   */
  appendMinutes(callId: string, expectThroughSeq: number | null, add: MinutesAddition): Promise<MinutesRecord | null>;
  /**
   * An addition could not be written (it failed, or its budget refused it): the minutes stay as they are, marked as owing it, with
   * `attempts` runs of it made; the end and the attendees still move. Only while `throughSeq` is `expectThroughSeq`. True when marked.
   */
  oweMinutesAddition(callId: string, expectThroughSeq: number | null, owed: { attempts: number; endedAt: number; attendees: string[] }): Promise<boolean>;
  /** Count one more run of an owed addition, only when its count is still `expect` and below `max`. True when counted. */
  claimMinutesAddition(callId: string, expect: number, max: number): Promise<boolean>;
  /** Mark the attendees as told the minutes are ready; true only for the first caller (so the bell rings once, also across a restart). */
  claimMinutesNotice(callId: string, at: number): Promise<boolean>;
  /** Record the work item made for action item `index` of live minutes, only when that item has none yet. True when recorded. */
  setActionItemWorkItem(callId: string, index: number, workItemId: string): Promise<boolean>;
  /** Delete minutes and tombstones created at or before `cutoffMs`. Returns how many went. */
  sweepMinutes(cutoffMs: number): Promise<number>;
  /** Record a proposal; an existing (call, id) is returned as it is with `created: false`. */
  createProposal(proposal: Proposal): Promise<{ proposal: Proposal; created: boolean }>;
  getProposal(callId: string, id: string): Promise<Proposal | null>;
  /** The call's proposals, oldest first. */
  listProposals(callId: string): Promise<Proposal[]>;
  /**
   * Write the proposal's state, responses, dismissal, executor, run, expiry and update time, bumping its version, ONLY when the stored
   * version is `expectedVersion`. Null when it is unknown or someone else wrote first. The frozen fields (statement, outcome, digest,
   * named people) are never touched.
   */
  saveProposal(next: Proposal, expectedVersion: number): Promise<Proposal | null>;
  /** Set the expiry of every proposal of the call that has none yet (the call ended). Returns how many were set. */
  setProposalExpiry(callId: string, expiresAt: number): Promise<number>;
  /** Proposals of any call still answerable (open, objected, consented) whose expiry is at or before `nowMs`, oldest expiry first. */
  dueProposals(nowMs: number, limit: number): Promise<Proposal[]>;
}

export interface MinutesFilter { tenant: string; userId: string; initiativeId?: string; before?: number; limit: number }

const copy = <T>(v: T): T => structuredClone(v);
const addTo = (list: string[], id: string): void => { if (!list.includes(id)) list.push(id); };

export class MemoryAssistantStore implements AssistantStore {
  private readonly records = new Map<string, AssistantRecord>();
  private readonly transcript = new Map<string, TranscriptLine[]>();
  private readonly actions = new Map<string, AssistantAction>();
  private readonly turns = new Map<string, AssistantTurn>();
  private readonly minutes = new Map<string, MinutesRecord>();
  private readonly proposals = new Map<string, Proposal>();

  async get(callId: string) { const r = this.records.get(callId); return r ? copy(r) : null; }

  async create(record: AssistantRecord) {
    const existing = this.records.get(record.callId);
    if (existing) return { record: copy(existing), created: false };
    const stored = copy(record); stored.voice = record.voice === true;
    this.records.set(record.callId, stored);
    return { record: copy(stored), created: true };
  }

  async transition(callId: string, change: StateChange) {
    const r = this.records.get(callId);
    if (!r || !change.from.includes(r.state)) return null;
    r.state = change.to;
    if (change.to === 'paused') r.pausedBy = change.by;
    if (change.to === 'listening') r.pausedBy = null;
    if (change.to === 'left') { r.leftAt = change.at; r.leftBy = change.by; }
    return copy(r);
  }

  async rejoin(callId: string, change: RejoinChange) {
    // Read, compare and write in one synchronous step: of two rejoins at once only the first finds the leave it read.
    const r = this.records.get(callId);
    if (!r || r.state !== 'left' || r.leftAt !== change.leftAt) return null;
    if (this.minutes.get(callId)?.deleted || sessionOf(r).erasedAt != null) return null; // the call's words were erased: never joined again
    r.state = 'listening'; r.invitedBy = change.by; r.leftAt = null; r.leftBy = null; r.pausedBy = null;
    r.acked = [change.by]; r.presentAtInvite = [...new Set(change.present)];
    for (const u of change.present) addTo(r.attendees, u);
    r.voice = false;
    r.session = { ...sessionOf(r), ...copy(change.session) };
    return copy(r);
  }

  async ack(callId: string, userId: string) {
    const r = this.records.get(callId);
    if (!r) return null;
    addTo(r.acked, userId); addTo(r.attendees, userId);
    return copy(r);
  }

  async attend(callId: string, userId: string) {
    const r = this.records.get(callId);
    if (r && r.state !== 'left') addTo(r.attendees, userId); // attendance ends when Milo leaves (audit M1)
  }

  async appendLine(line: Omit<TranscriptLine, 'seq'>) {
    const r = this.records.get(line.callId);
    if (!r || r.state !== 'listening') return null;
    const rows = this.transcript.get(line.callId) ?? [];
    if (rows.some((x) => x.captionId === line.captionId)) return null;
    const stored: TranscriptLine = { ...line, seq: r.nextSeq };
    r.nextSeq += 1; r.linesStored += 1;
    rows.push(stored);
    this.transcript.set(line.callId, rows);
    return copy(stored);
  }

  async addRequest(callId: string, request: PendingRequest) {
    const r = this.records.get(callId);
    if (!r) return;
    r.requests += 1;
    r.pendingRequests.push(copy(request));
    if (r.pendingRequests.length > MAX_PENDING_REQUESTS) r.pendingRequests.splice(0, r.pendingRequests.length - MAX_PENDING_REQUESTS);
  }

  async lines(callId: string, after: number, limit: number) {
    return copy((this.transcript.get(callId) ?? []).filter((l) => l.seq > after).slice(0, limit));
  }

  async createAction(action: AssistantAction) {
    const key = `${action.callId}\0${action.actionId}`;
    const existing = this.actions.get(key);
    if (existing) return { action: copy(existing), created: false };
    this.actions.set(key, copy(action));
    return { action: copy(action), created: true };
  }

  async getAction(callId: string, actionId: string) { const a = this.actions.get(`${callId}\0${actionId}`); return a ? copy(a) : null; }

  async decideAction(callId: string, actionId: string, change: ActionChange) {
    const a = this.actions.get(`${callId}\0${actionId}`);
    if (!a || !change.from.includes(a.status)) return null;
    a.status = change.to; a.decidedBy = change.by; a.decidedAt = change.at;
    if (change.resultText !== undefined) a.resultText = change.resultText;
    return copy(a);
  }

  async setVoice(callId: string, on: boolean) {
    const r = this.records.get(callId);
    if (!r) return null;
    r.voice = on;
    return copy(r);
  }

  async patchSession(callId: string, patch: Partial<AssistantSession>, when?: { period?: number }) {
    const r = this.records.get(callId);
    if (!r) return null;
    if (when?.period !== undefined && periodOf(r) !== when.period) return null;
    r.session = { ...sessionOf(r), ...copy(patch) };
    return copy(r);
  }

  async bumpRefused(callId: string) {
    const r = this.records.get(callId);
    if (!r) return 0;
    const session = sessionOf(r);
    session.refusedCalls += 1;
    r.session = session;
    return session.refusedCalls;
  }

  async createTurn(turn: AssistantTurn) {
    const key = `${turn.callId}\0${turn.turnId}`;
    const existing = this.turns.get(key);
    if (existing) return { turn: copy(existing), created: false };
    this.turns.set(key, copy(turn));
    return { turn: copy(turn), created: true };
  }

  async getTurn(callId: string, turnId: string) { const t = this.turns.get(`${callId}\0${turnId}`); return t ? copy(t) : null; }

  async listTurns(callId: string, filter: TurnFilter = {}) {
    return [...this.turns.values()]
      .filter((t) => t.callId === callId && (!filter.askedBy || t.askedBy === filter.askedBy) && (!filter.statuses || filter.statuses.includes(t.status)))
      .sort((a, b) => a.createdAt - b.createdAt || a.turnId.localeCompare(b.turnId)).map(copy);
  }

  async claimTurn(callId: string, turnId: string, claim: { claimId: string; claimedAt: number }, nowMs: number) {
    const t = this.turns.get(`${callId}\0${turnId}`);
    const runnable = t && (t.kind === 'write' ? t.status === 'running' : t.status === 'pending');
    if (!t || !runnable || t.claimId !== undefined || t.expiresAt <= nowMs) return null;
    t.claimId = claim.claimId; t.claimedAt = claim.claimedAt;
    if (t.kind === 'write') t.expiresAt = Math.max(t.expiresAt, claim.claimedAt + WRITE_FINISH_MS);
    return copy(t);
  }

  async dueTurns(nowMs: number, limit: number) {
    return [...this.turns.values()].filter((t) => (t.status === 'pending' || t.status === 'running') && t.expiresAt <= nowMs)
      .sort((a, b) => a.expiresAt - b.expiresAt || a.turnId.localeCompare(b.turnId)).slice(0, limit).map(copy);
  }

  async moveTurn(callId: string, turnId: string, change: TurnChange) {
    const t = this.turns.get(`${callId}\0${turnId}`);
    if (!t || !change.from.includes(t.status)) return null;
    t.status = change.to;
    if (change.actionId !== undefined) t.actionId = change.actionId;
    return copy(t);
  }

  async sweepLines(cutoffMs: number) {
    let gone = 0;
    for (const [callId, rows] of this.transcript) {
      const state = this.records.get(callId)?.state;
      if (state === 'listening' || state === 'paused') continue;
      const keep = rows.filter((l) => l.at > cutoffMs);
      gone += rows.length - keep.length;
      if (keep.length) this.transcript.set(callId, keep); else this.transcript.delete(callId);
    }
    return gone;
  }

  async expiredCalls(cutoffMs: number, limit: number) {
    return [...this.records.values()].filter((r) => r.state !== 'listening' && r.state !== 'paused' && (r.leftAt ?? r.invitedAt) <= cutoffMs)
      .sort((a, b) => (a.leftAt ?? a.invitedAt) - (b.leftAt ?? b.invitedAt) || a.callId.localeCompare(b.callId)).slice(0, limit).map(copy);
  }

  async purgeCall(callId: string) {
    const r = this.records.get(callId);
    if (!r || r.state === 'listening' || r.state === 'paused') return false;
    this.records.delete(callId); this.transcript.delete(callId); this.minutes.delete(callId);
    for (const [k, t] of this.turns) if (t.callId === callId) this.turns.delete(k);
    for (const [k, a] of this.actions) if (a.callId === callId) this.actions.delete(k);
    for (const [k, p] of this.proposals) if (p.callId === callId) this.proposals.delete(k);
    return true;
  }

  async listByState(states: readonly AssistantState[], limit: number) {
    return [...this.records.values()].filter((r) => states.includes(r.state)).sort((a, b) => a.invitedAt - b.invitedAt || a.callId.localeCompare(b.callId)).slice(0, limit).map(copy);
  }

  async callsOfLobby(lobby: string, limit: number) {
    return [...this.records.values()].filter((r) => r.lobby === lobby).sort((a, b) => a.invitedAt - b.invitedAt || a.callId.localeCompare(b.callId)).slice(0, limit).map(copy);
  }

  async getMinutes(callId: string) { const m = this.minutes.get(callId); return m ? copy(m) : null; }

  async putMinutes(minutes: MinutesRecord) {
    const existing = this.minutes.get(minutes.callId);
    if (existing) return { minutes: copy(existing), created: false };
    this.minutes.set(minutes.callId, copy(minutes));
    return { minutes: copy(minutes), created: true };
  }

  async listMinutes(f: MinutesFilter) {
    return [...this.minutes.values()]
      .filter((m) => !m.deleted && m.tenant === f.tenant && m.attendees.includes(f.userId) && (!f.initiativeId || m.initiativeId === f.initiativeId) && (f.before === undefined || m.endedAt < f.before))
      .sort((a, b) => b.endedAt - a.endedAt || a.callId.localeCompare(b.callId)).slice(0, f.limit).map(copy);
  }

  async tombstoneMinutes(callId: string, by: string, at: number) {
    const r = this.records.get(callId);
    if (r && (r.state === 'listening' || r.state === 'paused')) return null; // Milo is in the call again: nothing is erased
    const rows = this.transcript.get(callId) ?? [];
    this.transcript.delete(callId);
    if (r) r.session = { ...sessionOf(r), erasedAt: at };
    // Every other place that holds the call's words (audit M2): the detector's pending requests, each turn's tool arguments and
    // each action's result text. Ids, statuses and times stay so the cards and the counters remain consistent.
    if (r) r.pendingRequests = [];
    // Open turns and cards are expired too, so a late result is refused.
    for (const t of this.turns.values()) if (t.callId === callId) { t.tool = { name: t.tool.name, args: REMOVED_BY_INVITER }; if (t.status === 'pending' || t.status === 'running') t.status = 'expired'; }
    for (const a of this.actions.values()) if (a.callId === callId) { a.argsDigest = ''; if (a.resultText !== null) a.resultText = REMOVED_BY_INVITER; if (a.status === 'waiting' || a.status === 'confirmed') a.status = 'expired'; }
    // Proposals hold the call's words (statement, reasons, arguments): they go with the delete.
    for (const [k, p] of this.proposals) if (p.callId === callId) this.proposals.delete(k);
    const old = this.minutes.get(callId);
    this.minutes.set(callId, tombstone(callId, old, r, by, at));
    return rows.length;
  }

  async claimMinutesAttempt(callId: string, expect: number, max: number) {
    const m = this.minutes.get(callId);
    if (!m || m.deleted || m.writer !== 'none' || !m.retryable) return false;
    const n = m.attempts ?? 1;
    if (n !== expect || n >= max) return false;
    m.attempts = n + 1;
    return true;
  }

  async rewriteMinutes(next: MinutesRecord) {
    const m = this.minutes.get(next.callId);
    if (!m || m.deleted || m.writer !== 'none') return false;
    this.minutes.set(next.callId, { ...copy(next), attempts: m.attempts ?? 1, notifiedAt: m.notifiedAt ?? null, createdAt: m.createdAt });
    return true;
  }

  async listRetryableMinutes(maxAttempts: number, limit: number) {
    return [...this.minutes.values()].filter((m) => !m.deleted && ((m.writer === 'none' && m.retryable && (m.attempts ?? 1) < maxAttempts)
      || (m.writer !== 'none' && m.additionOwed === true && (m.additionAttempts ?? 0) < maxAttempts)))
      .sort((a, b) => a.createdAt - b.createdAt || a.callId.localeCompare(b.callId)).slice(0, limit).map(copy);
  }

  async appendMinutes(callId: string, expectThroughSeq: number | null, add: MinutesAddition) {
    const m = this.minutes.get(callId);
    if (!m || m.deleted || m.writer === 'none' || (m.throughSeq ?? null) !== expectThroughSeq) return null;
    if (add.summary !== null) m.summary = add.summary;
    m.decisions.push(...copy(add.decisions)); m.actionItems.push(...copy(add.actionItems)); m.topics.push(...copy(add.topics));
    m.endedAt = add.endedAt; for (const u of add.attendees) addTo(m.attendees, u);
    m.lineCount = add.lineCount; m.throughSeq = add.throughSeq; m.truncated = m.truncated || add.truncated;
    if (add.added) { m.additions = (m.additions ?? 0) + 1; m.notifiedAt = null; m.additionOwed = false; m.additionAttempts = 0; }
    return copy(m);
  }

  async oweMinutesAddition(callId: string, expectThroughSeq: number | null, owed: { attempts: number; endedAt: number; attendees: string[] }) {
    const m = this.minutes.get(callId);
    if (!m || m.deleted || m.writer === 'none' || (m.throughSeq ?? null) !== expectThroughSeq) return false;
    m.additionOwed = true; m.additionAttempts = owed.attempts; m.endedAt = owed.endedAt;
    for (const u of owed.attendees) addTo(m.attendees, u);
    return true;
  }

  async claimMinutesAddition(callId: string, expect: number, max: number) {
    const m = this.minutes.get(callId);
    if (!m || m.deleted || m.writer === 'none' || !m.additionOwed) return false;
    const n = m.additionAttempts ?? 0;
    if (n !== expect || n >= max) return false;
    m.additionAttempts = n + 1;
    return true;
  }

  async claimMinutesNotice(callId: string, at: number) {
    const m = this.minutes.get(callId);
    if (!m || m.deleted || m.notifiedAt) return false;
    m.notifiedAt = at;
    return true;
  }

  async setActionItemWorkItem(callId: string, index: number, workItemId: string) {
    const m = this.minutes.get(callId);
    const item = m && !m.deleted ? m.actionItems[index] : undefined;
    if (!item || item.workItemId) return false;
    item.workItemId = workItemId;
    return true;
  }

  async sweepMinutes(cutoffMs: number) {
    let gone = 0;
    for (const [id, m] of this.minutes) if (m.createdAt <= cutoffMs) { this.minutes.delete(id); gone += 1; }
    return gone;
  }

  async createProposal(proposal: Proposal) {
    const key = `${proposal.callId}\0${proposal.id}`;
    const existing = this.proposals.get(key);
    if (existing) return { proposal: copy(existing), created: false };
    // Like the SQL insert, which takes the tenant from the call's record: no record, no proposal.
    const r = this.records.get(proposal.callId);
    if (!r) throw new Error('meeting assistant proposal has no call record');
    const stored = { ...copy(proposal), tenant: r.tenant };
    this.proposals.set(key, stored);
    return { proposal: copy(stored), created: true };
  }

  async getProposal(callId: string, id: string) { const p = this.proposals.get(`${callId}\0${id}`); return p ? copy(p) : null; }

  async listProposals(callId: string) {
    return [...this.proposals.values()].filter((p) => p.callId === callId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(copy);
  }

  async saveProposal(next: Proposal, expectedVersion: number) {
    // Read, compare and write in one synchronous step: no await between them, so two saves cannot both pass the check.
    const p = this.proposals.get(`${next.callId}\0${next.id}`);
    if (!p || p.version !== expectedVersion) return null;
    p.state = next.state; p.responses = copy(next.responses); p.dismissedBy = next.dismissedBy; p.executor = next.executor;
    p.run = next.run ? copy(next.run) : null; p.expiresAt = next.expiresAt; p.updatedAt = next.updatedAt; p.version = expectedVersion + 1;
    return copy(p);
  }

  async setProposalExpiry(callId: string, expiresAt: number) {
    let set = 0;
    for (const p of this.proposals.values()) if (p.callId === callId && p.expiresAt === null) { p.expiresAt = expiresAt; p.version += 1; set += 1; }
    return set;
  }

  async dueProposals(nowMs: number, limit: number) {
    return [...this.proposals.values()]
      .filter((p) => (p.state === 'open' || p.state === 'objected' || p.state === 'consented') && p.expiresAt !== null && p.expiresAt <= nowMs)
      .sort((a, b) => a.expiresAt! - b.expiresAt! || a.id.localeCompare(b.id)).slice(0, limit).map(copy);
  }
}

/** What stays after a delete: who and when, nothing of the content. */
export function tombstone(callId: string, old: MinutesRecord | undefined, record: AssistantRecord | undefined, by: string, at: number): MinutesRecord {
  return {
    callId, tenant: old?.tenant ?? record?.tenant ?? '', lobby: old?.lobby ?? record?.lobby ?? '', initiativeId: old?.initiativeId ?? record?.initiativeId ?? null,
    callName: '', startedAt: old?.startedAt ?? 0, endedAt: old?.endedAt ?? 0, invitedBy: old?.invitedBy ?? record?.invitedBy ?? '', attendees: [],
    summary: '', decisions: [], actionItems: [], topics: [], lineCount: 0, truncated: false, writer: 'none', createdAt: old?.createdAt ?? at, deleted: { at, by },
  };
}

/** The initiative a call lobby belongs to (`orgiq:initiative:<id>`), or null. */
export function initiativeOfLobby(lobby: string): string | null {
  return /^orgiq:initiative:([A-Za-z0-9:_-]{1,200})$/.exec(lobby)?.[1] ?? null;
}
