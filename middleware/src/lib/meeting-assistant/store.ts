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
import type { AssistantRecord, AssistantState, PendingRequest, TranscriptLine } from './types.js';

export const MAX_PENDING_REQUESTS = 20;
export const MAX_LINE_CHARS = 2000;

export interface StateChange {
  /** The states this change may start from; anything else leaves the record alone and returns null. */
  from: readonly AssistantState[];
  to: AssistantState;
  by: string;
  at: number;
}

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
  /** Delete lines at or before `cutoffMs` (epoch). Returns how many went. */
  sweepLines(cutoffMs: number): Promise<number>;
}

const copy = <T>(v: T): T => structuredClone(v);
const addTo = (list: string[], id: string): void => { if (!list.includes(id)) list.push(id); };

export class MemoryAssistantStore implements AssistantStore {
  private readonly records = new Map<string, AssistantRecord>();
  private readonly transcript = new Map<string, TranscriptLine[]>();

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
