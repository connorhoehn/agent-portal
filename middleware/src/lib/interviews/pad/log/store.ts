// The pad log (docs/interviews-tenant-plan.md decision 12, row I4.3; contract U3). `interview_pad_events`.
//
// Append-only: an event is written once and never edited; events leave only through `erase` (retention, decision 17:
// the code log is media, 90 days). Each interview's events carry a `seq` that only grows, given by the store at append
// time after the interview's last one, so a reader asks for what came after the `seq` it holds.
//
//   who / side   the session's person (`panel`) or the invite's guest (`candidate`), set by the route, never the body
//   at           the server's time; `clientAt` is what the browser said, kept for playback order within a burst
//   counts       from, inserted, deleted, length, lines: how much changed and where, never the characters typed
//   text         a snapshot's whole document; null on every other kind
//
// Who may write and whether the input is good are decided before the store is called (routes/interviews/pad.ts,
// routes/interview-invite-pad.ts, ./rules.ts). Two implementations behind one interface, chosen as
// lib/interviews/milo-notes/store.ts chooses: the memory store over the registered fixture (mock/interviews-pad-log.ts)
// under the mock providers, the SQL store (store-sql.ts) otherwise. __tests__/store.test.ts runs one contract over both.
import { config } from '../../../../config.js';
import { interviewPadLogFixture } from '../../../../mock/interviews-pad-log.js';
import type { PadEventKind, PadSide } from './rules.js';
import { SqlPadLogStore } from './store-sql.js';

export interface PadEventRecord {
  interviewId: string;
  seq: number;
  at: string;
  clientAt: string;
  whoId: string;
  side: PadSide;
  kind: PadEventKind;
  from: number | null;
  inserted: number | null;
  deleted: number | null;
  length: number | null;
  lines: number | null;
  via: 'paste' | 'drop' | null;
  language: string | null;
  questionId: string | null;
  /** A snapshot's text; null on every other kind. */
  text: string | null;
}

/** An event as the route hands it to `append`: everything but the interview and the `seq`. */
export type NewPadEvent = Omit<PadEventRecord, 'interviewId' | 'seq'>;

/** The kinds that name a question. */
export type QuestionEventKind = Extract<PadEventKind, 'insert' | 'reveal'>;

export interface PadLogCounts { events: number; snapshots: number; lastSeq: number }

export interface PadLogStore {
  /** How many events and snapshots the interview has, and its last `seq` (0 when none). */
  counts(interviewId: string): Promise<PadLogCounts>;
  /** Append in order, each with the next `seq` after the interview's last; the stored rows, `seq` ascending. */
  append(interviewId: string, events: readonly NewPadEvent[]): Promise<PadEventRecord[]>;
  /** The interview's events with `seq` > `afterSeq`, ascending, at most `limit`. */
  listAfter(interviewId: string, afterSeq: number, limit: number): Promise<PadEventRecord[]>;
  /** The interview's last snapshot, or null. */
  latestSnapshot(interviewId: string): Promise<PadEventRecord | null>;
  /** The question ids the interview's events of `kind` name, first first, each once: `insert` (a question posted into the
   *  pad, the default) or `reveal` (a question whose provided design the lead put on the shared board). */
  postedQuestionIds(interviewId: string, kind?: QuestionEventKind): Promise<string[]>;
  /** Remove every event of these interviews; how many went. */
  erase(interviewIds: readonly string[]): Promise<number>;
}

const copy = <T>(row: T): T => structuredClone(row);
const bySeq = (a: PadEventRecord, b: PadEventRecord) => a.seq - b.seq;

export class MemoryPadLogStore implements PadLogStore {
  private rows(): PadEventRecord[] { return interviewPadLogFixture.rows(); }
  private of(interviewId: string): PadEventRecord[] { return this.rows().filter((r) => r.interviewId === interviewId); }

  async counts(interviewId: string): Promise<PadLogCounts> {
    const mine = this.of(interviewId);
    return { events: mine.length, snapshots: mine.filter((r) => r.kind === 'snapshot').length, lastSeq: mine.reduce((m, r) => Math.max(m, r.seq), 0) };
  }

  async append(interviewId: string, events: readonly NewPadEvent[]): Promise<PadEventRecord[]> {
    let last = (await this.counts(interviewId)).lastSeq;
    const stored = events.map((e) => ({ ...copy(e), interviewId, seq: (last += 1) }));
    this.rows().push(...stored.map(copy));
    return stored;
  }

  async listAfter(interviewId: string, afterSeq: number, limit: number): Promise<PadEventRecord[]> {
    return this.of(interviewId).filter((r) => r.seq > afterSeq).sort(bySeq).slice(0, Math.max(0, limit)).map(copy);
  }

  async latestSnapshot(interviewId: string): Promise<PadEventRecord | null> {
    const snaps = this.of(interviewId).filter((r) => r.kind === 'snapshot').sort(bySeq);
    const last = snaps[snaps.length - 1];
    return last ? copy(last) : null;
  }

  async postedQuestionIds(interviewId: string, kind: QuestionEventKind = 'insert'): Promise<string[]> {
    const ids = this.of(interviewId).filter((r) => r.kind === kind && r.questionId).sort(bySeq).map((r) => r.questionId!);
    return [...new Set(ids)];
  }

  async erase(interviewIds: readonly string[]): Promise<number> {
    const ids = new Set(interviewIds);
    const rows = this.rows();
    const keep = rows.filter((r) => !ids.has(r.interviewId));
    const gone = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    return gone;
  }
}

let current: PadLogStore | null = null;

export function createPadLogStore(): PadLogStore {
  if (config.mock?.aurora) return new MemoryPadLogStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlPadLogStore(async (sql, params) => (await import('../../../../providers/aurora.js')).exec(sql, params));
}

export function padLogStore(): PadLogStore { return (current ??= createPadLogStore()); }
export function setPadLogStore(next: PadLogStore | null): void { current = next; }
