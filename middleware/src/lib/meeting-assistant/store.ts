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
//  * Reads return copies. `left` is final.
//  * An action is created once per (call, actionId); `decideAction` moves it only from the statuses
//    named in `from` and returns null otherwise, so two clicks decide once. A turn (a tool call waiting on the asker's
//    browser) is the same: created once per (call, turnId), `moveTurn` moves it only from the statuses named.
import type { AssistantAction, AssistantRecord, AssistantSession, AssistantState, AssistantTurn, PendingRequest, TranscriptLine, TurnStatus } from './types.js';
import { sessionOf } from './types.js';

export const MAX_PENDING_REQUESTS = 20;
export const MAX_LINE_CHARS = 2000;

export interface StateChange {
  /** The states this change may start from; anything else leaves the record alone and returns null. */
  from: readonly AssistantState[];
  to: AssistantState;
  by: string;
  at: number;
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
  /** Record that `userId` acknowledged the transcription notice (idempotent); null when there is no record. */
  ack(callId: string, userId: string): Promise<AssistantRecord | null>;
  /** Record that `userId` held a seat while the assistant was in the call (idempotent). */
  attend(callId: string, userId: string): Promise<void>;
  appendLine(line: Omit<TranscriptLine, 'seq'>): Promise<TranscriptLine | null>;
  addRequest(callId: string, request: PendingRequest): Promise<void>;
  lines(callId: string, after: number, limit: number): Promise<TranscriptLine[]>;
  /** Record an action card; an existing (call, actionId) is returned as it is with `created: false`. */
  createAction(action: AssistantAction): Promise<{ action: AssistantAction; created: boolean }>;
  getAction(callId: string, actionId: string): Promise<AssistantAction | null>;
  /** Move an action; null when it is unknown or not in one of `change.from`. */
  decideAction(callId: string, actionId: string, change: ActionChange): Promise<AssistantAction | null>;
  /** Merge fields into the record's session bookkeeping; null when there is no record. */
  patchSession(callId: string, patch: Partial<AssistantSession>): Promise<AssistantRecord | null>;
  /** Add one to the refused-call counter; the new count, or 0 when there is no record. */
  bumpRefused(callId: string): Promise<number>;
  /** Record a turn; an existing (call, turnId) is returned as it is with `created: false`. */
  createTurn(turn: AssistantTurn): Promise<{ turn: AssistantTurn; created: boolean }>;
  getTurn(callId: string, turnId: string): Promise<AssistantTurn | null>;
  listTurns(callId: string, filter?: TurnFilter): Promise<AssistantTurn[]>;
  /** Move a turn; null when it is unknown or not in one of `change.from` (two results settle once). */
  moveTurn(callId: string, turnId: string, change: TurnChange): Promise<AssistantTurn | null>;
  /** Delete lines at or before `cutoffMs` (epoch). Returns how many went. */
  sweepLines(cutoffMs: number): Promise<number>;
}

const copy = <T>(v: T): T => structuredClone(v);
const addTo = (list: string[], id: string): void => { if (!list.includes(id)) list.push(id); };

export class MemoryAssistantStore implements AssistantStore {
  private readonly records = new Map<string, AssistantRecord>();
  private readonly transcript = new Map<string, TranscriptLine[]>();
  private readonly actions = new Map<string, AssistantAction>();
  private readonly turns = new Map<string, AssistantTurn>();

  async get(callId: string) { const r = this.records.get(callId); return r ? copy(r) : null; }

  async create(record: AssistantRecord) {
    const existing = this.records.get(record.callId);
    if (existing) return { record: copy(existing), created: false };
    this.records.set(record.callId, copy(record));
    return { record: copy(record), created: true };
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

  async ack(callId: string, userId: string) {
    const r = this.records.get(callId);
    if (!r) return null;
    addTo(r.acked, userId); addTo(r.attendees, userId);
    return copy(r);
  }

  async attend(callId: string, userId: string) {
    const r = this.records.get(callId);
    if (r) addTo(r.attendees, userId);
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

  async patchSession(callId: string, patch: Partial<AssistantSession>) {
    const r = this.records.get(callId);
    if (!r) return null;
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
      const keep = rows.filter((l) => l.at > cutoffMs);
      gone += rows.length - keep.length;
      if (keep.length) this.transcript.set(callId, keep); else this.transcript.delete(callId);
    }
    return gone;
  }
}

/** The initiative a call lobby belongs to (`orgiq:initiative:<id>`), or null. */
export function initiativeOfLobby(lobby: string): string | null {
  return /^orgiq:initiative:([A-Za-z0-9:_-]{1,200})$/.exec(lobby)?.[1] ?? null;
}
