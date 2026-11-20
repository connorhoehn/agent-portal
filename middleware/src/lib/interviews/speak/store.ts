// The log of what Milo said, or tried to say, in an interview call (docs/interviews-tenant-plan.md decisions 8, 9, 10, 17).
// `interview_said_log`. One row per time the server put approved words in the call: a question the lead approved (a
// suggestion's "Have Milo ask", or a kit question from the Questions tab), and Milo's answers to the candidate's two fixed
// requests and its one fixed refusal. The row is written BEFORE the words are posted or said, so the log never misses
// something the candidate heard; `posted` is set once the words reached the call chat, and `spoken` once they were
// relayed aloud.
//
// Append-only: a row is written once; only `posted` and `spoken` are ever set (false to true). Rows leave only through `erase`
// (retention: a decision record, like the coach's log). Two implementations behind one interface, chosen as
// lib/interviews/coach/store.ts chooses: memory under the mock providers, SQL (store-sql.ts) otherwise. The memory store's
// rows live in this process only (the mock world's reset does not clear them; nothing seeded reads them).
import { config } from '../../../config.js';
import { SqlSaidStore } from './store-sql.js';

/** `question`: words the lead approved to be asked. `answer`: Milo's answer to the candidate, from text the server holds. */
export type SaidKind = 'question' | 'answer';
/**
 * Where the words came from. `intro`: Milo's fixed introduction, once an interview, asked for by the lead. `tests`, `imports`
 * and `helper`: Milo's line after one of its interview tools wrote into the pad (milo-tools: test cases, import lines, a helper).
 * `ack`: "On it.", said while a slow pad tool's call is on its way.
 */
export type SaidSource = 'suggestion' | 'kit' | 'repeat' | 'time' | 'refusal' | 'intro' | 'tests' | 'imports' | 'helper' | 'ack' | 'probe';
export const SAID_SOURCES: readonly SaidSource[] = ['suggestion', 'kit', 'repeat', 'time', 'refusal', 'intro', 'tests', 'imports', 'helper', 'ack', 'probe'];

export interface SaidRecord {
  id: string;
  interviewId: string;
  callId: string | null;
  kind: SaidKind;
  source: SaidSource;
  /** The kit question (source `kit`), or the suggestion (source `suggestion`); null for an answer. */
  questionId: string | null;
  suggestionId: string | null;
  text: string;
  /** Who asked for it: the lead, or the candidate's guest id. */
  askedBy: string;
  saidAt: string;
  /** True once the words were posted in the call chat: the candidate read them. A row that never got there was not said. */
  posted: boolean;
  /** True once the words were relayed aloud on the call's voice. */
  spoken: boolean;
  /** Cut part way (a later word was not the text's, or the voice stopped): the words heard; `spoken` stays false. */
  spokenPart?: string;
}

export interface SaidStore {
  /** The interview's rows, oldest first. */
  list(interviewId: string): Promise<SaidRecord[]>;
  /** Append one row; a used id throws. */
  append(row: SaidRecord): Promise<SaidRecord>;
  /** Set `posted`; the row as it now is, or null when there is no such row. */
  markPosted(interviewId: string, id: string): Promise<SaidRecord | null>;
  /** Set `spoken`; the row as it now is, or null when there is no such row. */
  markSpoken(interviewId: string, id: string): Promise<SaidRecord | null>;
  /** Some of it was heard before it was cut: the words heard (a row already spoken is left as it is). */
  markSpokenPart(interviewId: string, id: string, heard: string): Promise<SaidRecord | null>;
  /** Remove every row of these interviews; how many went. */
  erase(interviewIds: readonly string[]): Promise<number>;
}

const copy = <T>(row: T): T => structuredClone(row);
const bySaid = (a: SaidRecord, b: SaidRecord) => a.saidAt.localeCompare(b.saidAt) || a.id.localeCompare(b.id);

export class MemorySaidStore implements SaidStore {
  private readonly rows: SaidRecord[] = [];

  async list(interviewId: string): Promise<SaidRecord[]> {
    return this.rows.filter((r) => r.interviewId === interviewId).sort(bySaid).map(copy);
  }

  async append(row: SaidRecord): Promise<SaidRecord> {
    if (this.rows.some((r) => r.id === row.id)) throw new Error('said log id already used');
    this.rows.push(copy(row));
    return copy(row);
  }

  async markPosted(interviewId: string, id: string): Promise<SaidRecord | null> {
    return this.mark(interviewId, id, 'posted');
  }

  async markSpoken(interviewId: string, id: string): Promise<SaidRecord | null> {
    return this.mark(interviewId, id, 'spoken');
  }

  async markSpokenPart(interviewId: string, id: string, heard: string): Promise<SaidRecord | null> {
    const row = this.rows.find((r) => r.interviewId === interviewId && r.id === id);
    if (!row || row.spoken) return row ? copy(row) : null;
    row.spokenPart = heard.slice(0, 1500);
    return copy(row);
  }

  private mark(interviewId: string, id: string, field: 'posted' | 'spoken'): SaidRecord | null {
    const row = this.rows.find((r) => r.interviewId === interviewId && r.id === id);
    if (!row) return null;
    row[field] = true;
    return copy(row);
  }

  async erase(interviewIds: readonly string[]): Promise<number> {
    const ids = new Set(interviewIds);
    const keep = this.rows.filter((r) => !ids.has(r.interviewId));
    const gone = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return gone;
  }
}

let current: SaidStore | null = null;

export function createSaidStore(): SaidStore {
  if (config.mock?.aurora) return new MemorySaidStore();
  return new SqlSaidStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function saidStore(): SaidStore { return (current ??= createSaidStore()); }
export function setSaidStore(next: SaidStore | null): void { current = next; }
