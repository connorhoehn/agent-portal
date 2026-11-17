// The consents store (docs/interviews-tenant-plan.md decision 5, row I2.3): one current record per interview.
//
// Two implementations behind one interface, chosen as lib/interviews/invite/store.ts chooses: the memory store
// over the registered fixture (mock/interviews-consents.ts) under the mock providers, the SQL store
// (store-sql.ts, schema/interviews_schema.sql `interview_consents`) otherwise. __tests__/store.test.ts runs one
// contract over both.
//
// History is kept in the same row: `history` is an append-only list with one entry per answer the candidate
// sent (the time, the notice version, the three answers as stored, and whether Milo was turned off because
// the transcript was declined). So the row says what is true now and what was answered when, under which
// notice, without a second table to keep in step.
//
// The store only writes. Whether the answers are complete, under the current notice and still changeable is
// decided above it (rules.ts, the guest route). A write names the revision it was made against (0 for the
// first answer, which inserts): a compare-and-set, so two tabs never overwrite each other unseen.

import { config } from '../../../config.js';
import { interviewConsentsFixture } from '../../../mock/interviews-consents.js';
import type { WriteResult } from '../store.js';
import { SqlConsentStore } from './store-sql.js';

/** One answer the candidate sent, as it was stored. Never edited, never removed. */
export interface ConsentHistoryEntry {
  at: string;
  noticeVersion: string;
  recording: boolean;
  transcription: boolean;
  milo: boolean;
  /** Milo was sent as yes and stored as no, because the transcript was declined. */
  miloForcedOff: boolean;
}

/** The interview's current consents. Flat, as the table holds it. */
export interface ConsentRecord {
  interviewId: string;
  /** The notice version the current answers were given under. */
  noticeVersion: string;
  recording: boolean;
  /** When the recording answer last took its present value. */
  recordingAt: string;
  transcription: boolean;
  transcriptionAt: string;
  milo: boolean;
  miloAt: string;
  /** When the set was first answered. */
  answeredAt: string;
  /** When the set was last written. */
  changedAt: string;
  history: ConsentHistoryEntry[];
  revision: number;
}

/** What a write sets: the record without its history and revision, and the one entry it appends. */
export type ConsentWrite = Omit<ConsentRecord, 'history' | 'revision' | 'answeredAt'> & { entry: ConsentHistoryEntry };

export interface ConsentStore {
  getConsent(interviewId: string): Promise<ConsentRecord | null>;
  /**
   * Save the interview's consents against `revision` (0: there is none yet, insert at 1). `not-found` never
   * happens here (the route has found the interview); `stale` carries the record as it now is.
   */
  saveConsent(write: ConsentWrite, revision: number): Promise<WriteResult<ConsentRecord>>;
}

const copy = (row: ConsentRecord | undefined | null): ConsentRecord | null => (row ? structuredClone(row) : null);

export class MemoryConsentStore implements ConsentStore {
  private rows(): ConsentRecord[] { return interviewConsentsFixture.rows(); }

  async getConsent(interviewId: string): Promise<ConsentRecord | null> {
    return copy(this.rows().find((r) => r.interviewId === interviewId));
  }

  async saveConsent(write: ConsentWrite, revision: number): Promise<WriteResult<ConsentRecord>> {
    const { entry, ...fields } = structuredClone(write);
    const rows = this.rows();
    const current = rows.find((r) => r.interviewId === write.interviewId);
    if (!current) {
      if (revision !== 0) return { ok: false, reason: 'not-found' };
      const row: ConsentRecord = { ...fields, answeredAt: fields.changedAt, history: [entry], revision: 1 };
      rows.push(row);
      return { ok: true, row: structuredClone(row) };
    }
    if (current.revision !== revision) return { ok: false, reason: 'stale', row: structuredClone(current) };
    Object.assign(current, fields, { history: [...current.history, entry], revision: current.revision + 1 });
    return { ok: true, row: structuredClone(current) };
  }
}

let current: ConsentStore | null = null;

export function createConsentStore(): ConsentStore {
  if (config.mock?.aurora) return new MemoryConsentStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlConsentStore(async (sql, params) => (await import('../../../providers/aurora.js')).exec(sql, params));
}

export function consentStore(): ConsentStore { return (current ??= createConsentStore()); }
export function setConsentStore(next: ConsentStore | null): void { current = next; }
