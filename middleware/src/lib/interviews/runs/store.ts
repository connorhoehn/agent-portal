// The run log (docs/interviews-tenant-plan.md "The run interface", decision 13; row I4.4): one row per run of an
// interview, keyed by the interview and the caller's `runId`.
//
// A row holds the request (its language, entrypoint, each file's path and size, and the submitted source itself, kept
// with the run as the code log's companion for playback), who started it and their side, its status and times, its
// events (each with the run's `seq` and an order `n` across the whole interview, for a reader that reconnects) and its
// result. The hold's ids are kept so a run left in flight by a restart can give its money back.
//
// Writes, and nothing else:
//   insertRun     once per (interview, runId); a second insert answers `exists` with the first row;
//   appendEvents  adds events to a run that has no result yet;
//   setStatus     moves a run that has no result to `compiling` or `running` (and stamps `startedAt` once);
//   finishRun     writes the result once (WHERE there is none), with its last events; a second finish changes nothing;
//   eraseRuns     retention removes every row of the named interviews.
//
// Two implementations behind one interface, chosen as lib/interviews/coach/store.ts chooses: the memory store over the
// registered fixture (mock/interviews-runs.ts) under the mock providers, the SQL store (store-sql.ts,
// schema/interviews_schema.sql `interview_runs`) otherwise. __tests__/store.test.ts runs one contract over both.
import { config } from '../../../config.js';
import { interviewRunsFixture } from '../../../mock/interviews-runs.js';
import type { RunLanguage, RunResult, RunStatus, RunStream } from './executor.js';
import { SqlRunStore } from './store-sql.js';

export type RunSide = 'panel' | 'candidate';
export interface RunPerson { id: string; name: string; side: RunSide }

export interface StoredRunEvent { seq: number; n: number; stream: RunStream; data: string; at: string }

export interface RunRecord {
  interviewId: string;
  runId: string;
  language: RunLanguage;
  entrypoint: string;
  /** Each submitted file's path and size in UTF-8 bytes. */
  files: { path: string; bytes: number }[];
  /** The submitted files themselves. */
  source: { path: string; content: string }[];
  stdin: string | null;
  startedBy: RunPerson;
  status: RunStatus;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  result: RunResult | null;
  events: StoredRunEvent[];
  holdId: string | null;
  spendSourceId: string | null;
}

export type InsertResult = { ok: true; row: RunRecord } | { ok: false; reason: 'exists'; row: RunRecord };

export interface RunStore {
  getRun(interviewId: string, runId: string): Promise<RunRecord | null>;
  /** The interview's runs, oldest first. */
  listRuns(interviewId: string): Promise<RunRecord[]>;
  countRuns(interviewId: string): Promise<number>;
  insertRun(row: RunRecord): Promise<InsertResult>;
  appendEvents(interviewId: string, runId: string, events: readonly StoredRunEvent[]): Promise<void>;
  setStatus(interviewId: string, runId: string, status: 'compiling' | 'running', at: string): Promise<RunRecord | null>;
  /** Write the result once; the row as it now is, or null when it was already finished (or is not there). */
  finishRun(interviewId: string, runId: string, result: RunResult, endedAt: string, events: readonly StoredRunEvent[]): Promise<RunRecord | null>;
  /** Every run, of any interview, that has no result: what a restart left in flight. */
  listUnfinished(): Promise<RunRecord[]>;
  eraseRuns(interviewIds: readonly string[]): Promise<number>;
}

const copy = <T>(row: T): T => structuredClone(row);
const byQueued = (a: RunRecord, b: RunRecord) => a.queuedAt.localeCompare(b.queuedAt) || a.runId.localeCompare(b.runId);

export class MemoryRunStore implements RunStore {
  private rows(): RunRecord[] { return interviewRunsFixture.rows(); }
  private find(interviewId: string, runId: string): RunRecord | undefined {
    return this.rows().find((r) => r.interviewId === interviewId && r.runId === runId);
  }

  async getRun(interviewId: string, runId: string): Promise<RunRecord | null> {
    const r = this.find(interviewId, runId);
    return r ? copy(r) : null;
  }

  async listRuns(interviewId: string): Promise<RunRecord[]> {
    return this.rows().filter((r) => r.interviewId === interviewId).sort(byQueued).map(copy);
  }

  async countRuns(interviewId: string): Promise<number> {
    return this.rows().filter((r) => r.interviewId === interviewId).length;
  }

  async insertRun(row: RunRecord): Promise<InsertResult> {
    const had = this.find(row.interviewId, row.runId);
    if (had) return { ok: false, reason: 'exists', row: copy(had) };
    this.rows().push(copy(row));
    return { ok: true, row: copy(row) };
  }

  async appendEvents(interviewId: string, runId: string, events: readonly StoredRunEvent[]): Promise<void> {
    const r = this.find(interviewId, runId);
    if (r && r.result === null) r.events.push(...copy([...events]));
  }

  async setStatus(interviewId: string, runId: string, status: 'compiling' | 'running', at: string): Promise<RunRecord | null> {
    const r = this.find(interviewId, runId);
    if (!r || r.result !== null) return null;
    r.status = status;
    r.startedAt ??= at;
    return copy(r);
  }

  async finishRun(interviewId: string, runId: string, result: RunResult, endedAt: string, events: readonly StoredRunEvent[]): Promise<RunRecord | null> {
    const r = this.find(interviewId, runId);
    if (!r || r.result !== null) return null;
    r.result = copy(result);
    r.status = result.status;
    r.endedAt = endedAt;
    r.events.push(...copy([...events]));
    return copy(r);
  }

  async listUnfinished(): Promise<RunRecord[]> {
    return this.rows().filter((r) => r.result === null).sort(byQueued).map(copy);
  }

  async eraseRuns(interviewIds: readonly string[]): Promise<number> {
    const ids = new Set(interviewIds);
    const rows = this.rows();
    const keep = rows.filter((r) => !ids.has(r.interviewId));
    const gone = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    return gone;
  }
}

let current: RunStore | null = null;

export function createRunStore(): RunStore {
  if (config.mock?.aurora) return new MemoryRunStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlRunStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function runStore(): RunStore { return (current ??= createRunStore()); }
export function setRunStore(next: RunStore | null): void { current = next; }
