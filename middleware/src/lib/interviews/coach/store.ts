// The suggestion log (docs/interviews-tenant-plan.md decision 8, "The model": Suggestion log; row I3.3).
//
// Append-only: one row per time the coach was asked to think. A row is never edited except to fill what was empty:
//   shownAt     set once, the first time the lead's room read it;
//   answer      set once (`ask`, `milo-ask` or `skip`) with answeredAt; a second answer is `stale` (409 at the route);
//   spoken      false until row I3.5 says Milo said it aloud.
// A dropped answer (the model's text was malformed, off the kit, too long, unsourced, judging or personal, or the call
// failed) is a row with its code in `dropped` and NO text, competency or quote: the count is the number of such rows.
// Rows leave only through `eraseSuggestions` (retention, D6).
//
// Two implementations behind one interface, chosen as lib/interviews/consent/store.ts chooses: the memory store over the
// registered fixture (mock/interviews-suggestions.ts) under the mock providers, the SQL store (store-sql.ts,
// schema/interviews_schema.sql `interview_suggestions`) otherwise. __tests__/store.test.ts runs one contract over both.
import { config } from '../../../config.js';
import { interviewSuggestionsFixture } from '../../../mock/interviews-suggestions.js';
import type { WriteResult } from '../store.js';
import { SqlSuggestionStore } from './store-sql.js';

export type SuggestionAnswer = 'ask' | 'milo-ask' | 'skip';
export const SUGGESTION_ANSWERS: readonly SuggestionAnswer[] = ['ask', 'milo-ask', 'skip'];
/** Why an attempt left no suggestion: parse.ts's codes, a failed call, or the stand-in with nothing left. */
export type SuggestionDropCode = 'malformed' | 'off-kit' | 'too-long' | 'unsourced' | 'judges' | 'personal' | 'timeout' | 'error' | 'nothing';

export interface SuggestionRecord {
  id: string;
  interviewId: string;
  /** The call whose transcript was read, and its last line read: "no new lines" is judged against these. */
  callId: string | null;
  throughSeq: number;
  /** Empty on a dropped row. */
  text: string;
  competencyId: string | null;
  /** The transcript words it builds on, quoted; null when it builds on nothing said. */
  basedOn: string | null;
  madeAt: string;
  shownAt: string | null;
  answer: SuggestionAnswer | null;
  answeredAt: string | null;
  spoken: boolean;
  modelId: string;
  promptVersion: string;
  /** Null for a suggestion; the code for a dropped attempt. */
  dropped: SuggestionDropCode | null;
}

export interface SuggestionStore {
  /** The interview's rows, oldest first. */
  listSuggestions(interviewId: string): Promise<SuggestionRecord[]>;
  appendSuggestion(row: SuggestionRecord): Promise<SuggestionRecord>;
  /** Set `shownAt` when it is empty; the row as it now is, or null when there is no such row. */
  markShown(interviewId: string, id: string, at: string): Promise<SuggestionRecord | null>;
  /** Answer an unanswered suggestion; `stale` (with the row) when it was answered already, `not-found` for no row or a dropped one. */
  answerSuggestion(interviewId: string, id: string, answer: SuggestionAnswer, at: string): Promise<WriteResult<SuggestionRecord>>;
  /** Remove every row of these interviews; how many went. */
  eraseSuggestions(interviewIds: readonly string[]): Promise<number>;
  /** Row I3.5: set `spoken` on an answered `milo-ask` row once Milo said it aloud; the row as it now is, or null. */
  markSpoken?(interviewId: string, id: string): Promise<SuggestionRecord | null>;
}

const copy = <T>(row: T): T => structuredClone(row);
const byMade = (a: SuggestionRecord, b: SuggestionRecord) => a.madeAt.localeCompare(b.madeAt) || a.id.localeCompare(b.id);

export class MemorySuggestionStore implements SuggestionStore {
  private rows(): SuggestionRecord[] { return interviewSuggestionsFixture.rows(); }

  async listSuggestions(interviewId: string): Promise<SuggestionRecord[]> {
    return this.rows().filter((r) => r.interviewId === interviewId).sort(byMade).map(copy);
  }

  async appendSuggestion(row: SuggestionRecord): Promise<SuggestionRecord> {
    const rows = this.rows();
    if (rows.some((r) => r.id === row.id)) throw new Error('suggestion id already used');
    rows.push(copy(row));
    return copy(row);
  }

  async markShown(interviewId: string, id: string, at: string): Promise<SuggestionRecord | null> {
    const row = this.rows().find((r) => r.id === id && r.interviewId === interviewId);
    if (!row) return null;
    row.shownAt ??= at;
    return copy(row);
  }

  async answerSuggestion(interviewId: string, id: string, answer: SuggestionAnswer, at: string): Promise<WriteResult<SuggestionRecord>> {
    const row = this.rows().find((r) => r.id === id && r.interviewId === interviewId && r.dropped === null);
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.answer !== null) return { ok: false, reason: 'stale', row: copy(row) };
    row.answer = answer;
    row.answeredAt = at;
    return { ok: true, row: copy(row) };
  }

  async markSpoken(interviewId: string, id: string): Promise<SuggestionRecord | null> {
    const row = this.rows().find((r) => r.id === id && r.interviewId === interviewId && r.answer === 'milo-ask');
    if (!row) return null;
    row.spoken = true;
    return copy(row);
  }

  async eraseSuggestions(interviewIds: readonly string[]): Promise<number> {
    const ids = new Set(interviewIds);
    const rows = this.rows();
    const keep = rows.filter((r) => !ids.has(r.interviewId));
    const gone = rows.length - keep.length;
    rows.splice(0, rows.length, ...keep);
    return gone;
  }
}

let current: SuggestionStore | null = null;

export function createSuggestionStore(): SuggestionStore {
  if (config.mock?.aurora) return new MemorySuggestionStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlSuggestionStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function suggestionStore(): SuggestionStore { return (current ??= createSuggestionStore()); }
export function setSuggestionStore(next: SuggestionStore | null): void { current = next; }
