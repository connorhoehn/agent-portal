// The log of what Milo showed the panel privately (docs/interviews-tenant-plan.md decision 8: everything Milo showed is
// logged; row I3.6; contract E5). `interview_coach_log`.
//
// Append-only: a row is written once and never edited; rows leave only through `eraseCoachLog` (retention, E7).
//   kind      `answer`: the lead's private question and Milo's answer (this module); `plan`: the question plan's draft
//             (row I3.10 writes those through `append`, with its own sources).
//   question  what the lead typed (an `answer` row), or what the plan was asked for.
//   answer    what was shown; empty when nothing was: a dropped answer (its code: malformed, too-long, unsourced, judges,
//             personal, off-kit, nothing, timeout, error) or a question refused before any model (refused-judgement,
//             refused-personal: the person was shown the one fixed sentence, which is not stored as text).
//   sources   `{ seq, quote }` for an answer (each quote found in that transcript line); `{ questionId, why }` for a plan.
//
// Two implementations behind one interface, chosen as lib/interviews/coach/store.ts chooses: the memory store over the
// registered fixture (mock/interviews-coach-log.ts) under the mock providers, the SQL store (store-sql.ts) otherwise.
// __tests__/store.test.ts runs one contract over both.
import { config } from '../../../config.js';
import { interviewCoachLogFixture } from '../../../mock/interviews-coach-log.js';
import { SqlCoachLogStore } from './store-sql.js';

export type CoachLogKind = 'answer' | 'plan';
export const COACH_LOG_KINDS: readonly CoachLogKind[] = ['answer', 'plan'];

export const COACH_LOG_CODES = [
  'malformed', 'too-long', 'unsourced', 'judges', 'personal', 'off-kit', 'nothing', 'timeout', 'error', 'refused-judgement', 'refused-personal',
] as const;
export type CoachLogCode = typeof COACH_LOG_CODES[number];

export type CoachLogSource = { seq: number; quote: string } | { questionId: string; why: string };

export interface CoachLogRecord {
  id: string;
  interviewId: string;
  kind: CoachLogKind;
  /** The person who asked (the lead). */
  askedBy: string;
  question: string;
  /** What was shown; empty with a code when nothing was. */
  answer: string;
  sources: CoachLogSource[];
  /** Null when an answer was shown. */
  code: CoachLogCode | null;
  askedAt: string;
  /** `none` when no model was asked (a refusal before the model). */
  modelId: string;
  promptVersion: string;
}

export interface CoachLogStore {
  /** The interview's rows of that kind (every kind when omitted), oldest first. */
  list(interviewId: string, kind?: CoachLogKind): Promise<CoachLogRecord[]>;
  /** Append one row; a used id throws. */
  append(row: CoachLogRecord): Promise<CoachLogRecord>;
  /** Remove every row of these interviews; how many went. */
  erase(interviewIds: readonly string[]): Promise<number>;
}

const copy = <T>(row: T): T => structuredClone(row);
const byAsked = (a: CoachLogRecord, b: CoachLogRecord) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id);

export class MemoryCoachLogStore implements CoachLogStore {
  private rows(): CoachLogRecord[] { return interviewCoachLogFixture.rows(); }

  async list(interviewId: string, kind?: CoachLogKind): Promise<CoachLogRecord[]> {
    return this.rows().filter((r) => r.interviewId === interviewId && (!kind || r.kind === kind)).sort(byAsked).map(copy);
  }

  async append(row: CoachLogRecord): Promise<CoachLogRecord> {
    const rows = this.rows();
    if (rows.some((r) => r.id === row.id)) throw new Error('coach log id already used');
    rows.push(copy(row));
    return copy(row);
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

let current: CoachLogStore | null = null;

export function createCoachLogStore(): CoachLogStore {
  if (config.mock?.aurora) return new MemoryCoachLogStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlCoachLogStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function coachLogStore(): CoachLogStore { return (current ??= createCoachLogStore()); }
export function setCoachLogStore(next: CoachLogStore | null): void { current = next; }
