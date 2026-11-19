// What the lead lets Milo do for the candidate in one interview (docs/interviews-tenant-plan.md, "Milo's interview tools").
// `interview_milo_settings`: one row per interview once the lead has changed something; no row reads as the defaults.
//
//   candidateMayAsk  the candidate may ask Milo to change the pad for them (milo-tools: test cases, imports, a helper). Off by
//                    default: that is help the candidate would not otherwise have, so whether a round offers it is the lead's
//                    choice, made in the round and kept with who made it and when (the record says what help was on offer).
//                    Turned off, a request gets one polite fixed sentence and costs nothing. The lead may always ask.
//
// Two implementations behind one interface, chosen as speak/store.ts chooses: memory under the mock providers, SQL otherwise.
// The row holds no one's words: the interview, a flag, and the lead who set it.
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../../config.js';
import { isoOf, type SqlExec } from './store-sql.js';

export interface MiloSettings {
  candidateMayAsk: boolean;
  /** Who last changed them and when; null while nobody has (the defaults). */
  updatedBy: string | null;
  updatedAt: string | null;
}

export const DEFAULT_MILO_SETTINGS: MiloSettings = Object.freeze({ candidateMayAsk: false, updatedBy: null, updatedAt: null });

export interface MiloSettingsStore {
  get(interviewId: string): Promise<MiloSettings>;
  /** Set the flag; the settings as they now are. */
  setCandidateMayAsk(interviewId: string, on: boolean, by: string, at: string): Promise<MiloSettings>;
}

export class MemoryMiloSettingsStore implements MiloSettingsStore {
  private readonly rows = new Map<string, MiloSettings>();
  async get(interviewId: string): Promise<MiloSettings> { return { ...(this.rows.get(interviewId) ?? DEFAULT_MILO_SETTINGS) }; }
  async setCandidateMayAsk(interviewId: string, on: boolean, by: string, at: string): Promise<MiloSettings> {
    const row = { candidateMayAsk: on, updatedBy: by, updatedAt: at };
    this.rows.set(interviewId, row);
    return { ...row };
  }
}

const COLUMNS = 'interview_id, candidate_may_ask, updated_by, updated_at';
export const GET_MILO_SETTINGS_SQL = `SELECT ${COLUMNS} FROM interview_milo_settings WHERE interview_id = :interview_id`;
export const SET_MILO_CANDIDATE_MAY_ASK_SQL = `INSERT INTO interview_milo_settings (${COLUMNS})
  VALUES (:interview_id, :candidate_may_ask, :updated_by, CAST(:updated_at AS TIMESTAMPTZ))
  ON CONFLICT (interview_id) DO UPDATE SET candidate_may_ask = EXCLUDED.candidate_may_ask, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
  RETURNING ${COLUMNS}`;

const text = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const fromRow = (r: Record<string, unknown>): MiloSettings => ({
  candidateMayAsk: r['candidate_may_ask'] === true || r['candidate_may_ask'] === 't' || r['candidate_may_ask'] === 'true',
  updatedBy: r['updated_by'] == null ? null : String(r['updated_by']),
  updatedAt: r['updated_at'] == null ? null : isoOf(r['updated_at']),
});

export class SqlMiloSettingsStore implements MiloSettingsStore {
  constructor(private readonly exec: SqlExec) {}
  async get(interviewId: string): Promise<MiloSettings> {
    const row = (await this.exec(GET_MILO_SETTINGS_SQL, [text('interview_id', interviewId)]))[0];
    return row ? fromRow(row) : { ...DEFAULT_MILO_SETTINGS };
  }
  async setCandidateMayAsk(interviewId: string, on: boolean, by: string, at: string): Promise<MiloSettings> {
    const out = await this.exec(SET_MILO_CANDIDATE_MAY_ASK_SQL, [
      text('interview_id', interviewId), { name: 'candidate_may_ask', value: { booleanValue: on } }, text('updated_by', by), text('updated_at', at),
    ]);
    if (!out[0]) throw new Error('Milo settings not stored');
    return fromRow(out[0]);
  }
}

let current: MiloSettingsStore | null = null;
export function miloSettingsStore(): MiloSettingsStore {
  return (current ??= config.mock?.aurora
    ? new MemoryMiloSettingsStore()
    : new SqlMiloSettingsStore(async (sql, params) => (await import('../../providers/aurora.js')).exec(sql, params)));
}
/** Tests: replace the store; `null` makes the next read choose again. */
export function setMiloSettingsStore(next: MiloSettingsStore | null): void { current = next; }
