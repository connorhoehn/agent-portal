// The two consent stores behave the same (lib/interviews/consent/store.ts; docs/interviews-tenant-plan.md row I2.3),
// and the module's two reads for the integrator (index.ts, contract C4).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { MemoryConsentStore, setConsentStore, type ConsentStore, type ConsentWrite } from '../store.js';
import { CONSENT_STATEMENTS, GET_CONSENT_SQL, INSERT_CONSENT_SQL, SqlConsentStore, UPDATE_CONSENT_SQL } from '../store-sql.js';
import type { SqlExec } from '../../store-sql.js';
import { consentsAnswered, consentsFor } from '../index.js';
import { CONSENT_NOTICE } from '../notice.js';
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewConsentsFixture, noticeAt } from '../../../../mock/interviews-consents.js';
import { interviewsFixture } from '../../../../mock/interviews.js';

const ts = (iso: string) => iso.replace('T', ' ').replace('Z', '');
type P = { stringValue?: string; booleanValue?: boolean; longValue?: number };
const param = (params: SqlParameter[] | undefined, name: string): P => (params?.find((x) => x.name === name)?.value ?? {}) as P;

/** interview_consents as the Data API would keep and answer it (booleans as booleans, history as JSON text). */
function consentsTableExec(): SqlExec {
  const table: Record<string, unknown>[] = [];
  const out = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
  return async (sql, params) => {
    const s = (n: string) => String(param(params, n).stringValue ?? '');
    const b = (n: string) => param(params, n).booleanValue === true;
    const set = (r: Record<string, unknown>) => Object.assign(r, {
      notice_version: s('notice_version'), recording: b('recording'), recording_at: ts(s('recording_at')),
      transcription: b('transcription'), transcription_at: ts(s('transcription_at')), milo: b('milo'), milo_at: ts(s('milo_at')),
      changed_at: ts(s('changed_at')),
    });
    if (sql === GET_CONSENT_SQL) return out(table.filter((r) => r['interview_id'] === s('interview_id')));
    if (sql === INSERT_CONSENT_SQL) {
      if (table.some((r) => r['interview_id'] === s('interview_id'))) return [];
      const row = set({ interview_id: s('interview_id'), answered_at: ts(s('changed_at')), history: JSON.stringify([JSON.parse(s('entry'))]), revision: 1 });
      table.push(row);
      return out([row]);
    }
    if (sql === UPDATE_CONSENT_SQL) {
      const r = table.find((x) => x['interview_id'] === s('interview_id') && x['revision'] === param(params, 'revision').longValue);
      if (!r) return [];
      set(r);
      r['history'] = JSON.stringify([...JSON.parse(String(r['history'])), JSON.parse(s('entry'))]);
      r['revision'] = Number(r['revision']) + 1;
      return out([r]);
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  };
}

const T = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString();
const write = (interviewId: string, minute: number, answers: { recording: boolean; transcription: boolean; milo: boolean }): ConsentWrite => ({
  interviewId, noticeVersion: CONSENT_NOTICE.version, ...answers,
  recordingAt: T(minute), transcriptionAt: T(minute), miloAt: T(minute), changedAt: T(minute),
  entry: { at: T(minute), noticeVersion: CONSENT_NOTICE.version, ...answers, miloForcedOff: false },
});

afterEach(() => { fixtureRegistry.resetAll('default'); setConsentStore(null); });

describe.each([
  ['memory', () => new MemoryConsentStore() as ConsentStore],
  ['sql', () => new SqlConsentStore(consentsTableExec()) as ConsentStore],
])('the %s consent store', (_name, make) => {
  let store: ConsentStore;
  beforeEach(() => { store = make(); });

  it('has nothing for an interview nobody answered, and inserts the first answer at revision 1 with one history entry', async () => {
    expect(await store.getConsent('iv-new')).toBeNull();
    const saved = await store.saveConsent(write('iv-new', 0, { recording: true, transcription: false, milo: false }), 0);
    expect(saved).toMatchObject({ ok: true, row: { interviewId: 'iv-new', recording: true, transcription: false, milo: false, answeredAt: T(0), changedAt: T(0), revision: 1 } });
    expect(saved.ok && saved.row.history).toHaveLength(1);
    expect(await store.getConsent('iv-new')).toEqual(saved.ok && saved.row);
  });

  it('changes against the revision read, appends to the history and keeps the first answer\'s time', async () => {
    await store.saveConsent(write('iv-new', 0, { recording: true, transcription: true, milo: true }), 0);
    const changed = await store.saveConsent(write('iv-new', 5, { recording: false, transcription: true, milo: true }), 1);
    expect(changed).toMatchObject({ ok: true, row: { recording: false, answeredAt: T(0), changedAt: T(5), revision: 2 } });
    expect(changed.ok && changed.row.history.map((h) => [h.at, h.recording])).toEqual([[T(0), true], [T(5), false]]);
  });

  it('refuses a stale write with the record as it now is, and a second first answer as stale', async () => {
    await store.saveConsent(write('iv-new', 0, { recording: true, transcription: true, milo: true }), 0);
    const again = await store.saveConsent(write('iv-new', 1, { recording: false, transcription: false, milo: false }), 0);
    expect(again).toMatchObject({ ok: false, reason: 'stale', row: { recording: true, revision: 1 } });
    const stale = await store.saveConsent(write('iv-new', 2, { recording: false, transcription: false, milo: false }), 7);
    expect(stale).toMatchObject({ ok: false, reason: 'stale', row: { revision: 1 } });
  });
});

describe('the seed', () => {
  it('the live round answered the current notice', () => {
    expect(interviewConsentsFixture.rows('default').find((r) => r.interviewId === 'iv-s4e8u2zk')!.noticeVersion).toBe(CONSENT_NOTICE.version);
  });

  it('holds consents for the finished interviews and the one live now, and none for the upcoming ones', () => {
    const finished = interviewsFixture.rows('default').filter((i) => ['ended', 'scored', 'reviewed', 'live'].includes(i.state)).map((i) => i.id).sort();
    const rows = interviewConsentsFixture.rows('default');
    expect(rows.map((r) => r.interviewId).sort()).toEqual(finished);
    for (const r of rows) {
      // Under the notice in force when it was given: never one dated after the answer (E4 finding 45).
      expect(r).toMatchObject({ noticeVersion: noticeAt(r.answeredAt), recording: true, transcription: true, milo: true });
      expect(Date.parse(`${r.noticeVersion.slice(0, 10)}T00:00:00Z`)).toBeLessThanOrEqual(Date.parse(r.answeredAt));
      const start = interviewsFixture.rows('default').find((i) => i.id === r.interviewId)!.scheduledAt!;
      expect(Date.parse(r.answeredAt)).toBeLessThan(Date.parse(start));
    }
  });
});

describe('the module\'s reads (C4)', () => {
  it('consentsAnswered: only a set under the current notice counts', async () => {
    expect(await consentsAnswered('iv-s4e8u2zk')).toBe(true);
    expect(await consentsAnswered('iv-k1p5w8ra')).toBe(false);
    interviewConsentsFixture.rows().find((r) => r.interviewId === 'iv-s4e8u2zk')!.noticeVersion = 'older';
    expect(await consentsAnswered('iv-s4e8u2zk')).toBe(false);
  });

  it('consentsFor: the stored answers, Milo held off without the transcript, null when nothing was answered', async () => {
    expect(await consentsFor('iv-s4e8u2zk')).toEqual({ recording: true, transcription: true, milo: true });
    expect(await consentsFor('iv-k1p5w8ra')).toBeNull();
    Object.assign(interviewConsentsFixture.rows().find((r) => r.interviewId === 'iv-s4e8u2zk')!, { transcription: false, milo: true });
    expect(await consentsFor('iv-s4e8u2zk')).toEqual({ recording: true, transcription: false, milo: false });
  });
});

describe('every consent statement matches schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const table = /CREATE TABLE IF NOT EXISTS interview_consents \(([\s\S]*?)\n\);/.exec(ddl)?.[1] ?? '';
  const columns = new Set([...table.matchAll(/^\s+([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]));

  it('declares the table, Milo-needs-the-transcript, and every column a statement names', () => {
    expect(columns.size).toBe(12);
    expect(table).toMatch(/CHECK \(transcription OR NOT milo\)/);
    for (const sql of CONSENT_STATEMENTS) {
      const named = [...sql.replace(/:[a-z_]+/g, '').matchAll(/\b([a-z]+(?:_[a-z]+)+|revision|history|recording|transcription|milo)\b/g)].map((m) => m[1]!)
        .filter((w) => !['interview_consents', 'jsonb_build_array'].includes(w));
      for (const col of named) expect([col, columns.has(col)]).toEqual([col, true]);
    }
  });
});
