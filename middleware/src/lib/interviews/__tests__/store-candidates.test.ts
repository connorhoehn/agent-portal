// createCandidate (store.ts; UI round 2, lane DESK-B) behaves the same in both stores: the candidate and its application are
// written together, a taken id writes neither, and the lists then show them. The SQL store runs its real statement against
// small stateful tables, and a last block holds it to schema/interviews_schema.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { DuplicateCandidateError, MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import { LIST_APPLICATIONS_SQL, LIST_CANDIDATES_SQL, SqlInterviewsStore, type SqlExec } from '../store-sql.js';
import type { Application, Candidate } from '../types.js';

function tablesExec(): SqlExec {
  const candidates: Array<Record<string, unknown>> = [];
  const apps: Array<Record<string, unknown>> = [];
  const keys = new Map<string, string>(); // the email_key column, by application id
  return async (sql, params: SqlParameter[] = []) => {
    const b = new Map(params.map((p) => [p.name!, p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? null]));
    if (sql === LIST_CANDIDATES_SQL) return [...candidates];
    if (sql === LIST_APPLICATIONS_SQL) return [...apps];
    if (sql === SqlInterviewsStore.CREATE_CANDIDATE_SQL) {
      if (candidates.some((c) => c['id'] === b.get('candidate_id')) || apps.some((a) => a['id'] === b.get('application_id'))) return [];
      candidates.push({ id: b.get('candidate_id'), name: b.get('name'), email: b.get('email'), headline: b.get('headline'), location: b.get('location'),
        source: b.get('source'), resume_file_id: null, notes: '', created_at: String(b.get('created_at')).replace('T', ' ').replace('Z', '') });
      const row = { id: b.get('application_id'), candidate_id: b.get('candidate_id'), opening_id: b.get('opening_id'), stage: b.get('stage'),
        applied_at: String(b.get('applied_at')).replace('T', ' ').replace('Z', ''), history: b.get('history') };
      apps.push(row);
      keys.set(String(row.id), `${String(b.get('opening_id'))}\u0000${String(b.get('email')).trim().toLowerCase()}`);
      return [row];
    }
    if (sql === SqlInterviewsStore.CREATE_APPLICATION_SQL) {
      // INSERT … SELECT FROM interview_candidates WHERE id = :candidate_id AND btrim(email) <> '', then the unique index.
      const c = candidates.find((x) => x['id'] === b.get('candidate_id') && String(x['email']).trim() !== '');
      if (!c || apps.some((a) => a['id'] === b.get('application_id'))) return [];
      const key = `${String(b.get('opening_id'))}\u0000${String(c['email']).trim().toLowerCase()}`;
      if ([...keys.values()].includes(key)) throw new Error('duplicate key value violates unique constraint "interview_applications_opening_email_key"');
      const row = { id: b.get('application_id'), candidate_id: c['id'], opening_id: b.get('opening_id'), stage: b.get('stage'),
        applied_at: String(b.get('applied_at')).replace('T', ' ').replace('Z', ''), history: b.get('history') };
      apps.push(row);
      keys.set(String(row.id), key);
      return [row];
    }
    if (sql === SqlInterviewsStore.UPDATE_CANDIDATE_SQL) {
      // UPDATE … WHERE id AND btrim(email) <> '' AND the version matches; the applications take the new key, judged by the index.
      const c = candidates.find((x) => x['id'] === b.get('id') && String(x['email']).trim() !== '');
      const stamp = (v: unknown) => Date.parse(`${String(v).replace(' ', 'T')}${String(v).endsWith('Z') ? '' : 'Z'}`);
      if (!c || stamp(c['updated_at'] ?? c['created_at']) !== Date.parse(String(b.get('based_on')))) return [];
      const mine = apps.filter((a) => a['candidate_id'] === c['id']);
      const next = new Map(keys);
      for (const a of mine) next.set(String(a['id']), `${String(a['opening_id'])}\u0000${String(b.get('email')).trim().toLowerCase()}`);
      if (new Set(next.values()).size !== next.size) throw new Error('duplicate key value violates unique constraint "interview_applications_opening_email_key"');
      for (const [k, v] of next) keys.set(k, v);
      Object.assign(c, { name: b.get('name'), email: b.get('email'), headline: b.get('headline'), location: b.get('location'), updated_at: String(b.get('at')).replace('T', ' ').replace('Z', '') });
      return [{ ...c }];
    }
    if (sql === SqlInterviewsStore.GET_CANDIDATE_SQL) return candidates.filter((x) => x['id'] === b.get('id')).map((x) => ({ ...x }));
    throw new Error(`unexpected statement: ${sql}`);
  };
}

afterEach(() => fixtureRegistry.resetAll('default'));

const AT = '2026-11-17T09:00:00.000Z';
const candidate = (id = 'cand-new1'): Candidate => ({ id, name: 'Nadia Petrova', email: 'nadia@mail.example', headline: 'Staff engineer', location: 'Prague', source: 'Referral', resumeFileId: null, notes: '', createdAt: AT });
const application = (id = 'app-new1', candidateId = 'cand-new1'): Application => ({
  id, candidateId, openingId: 'op-backend', stage: 'applied', appliedAt: AT, history: [{ stage: 'applied', at: AT, by: 'u-greta', reason: null }],
});

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(tablesExec()) as InterviewsStore],
])('the %s store\'s createCandidate', (_name, make) => {
  it('writes the candidate and the application together and both lists show them', async () => {
    const store = make();
    expect(await store.createCandidate(candidate(), application())).toEqual({ candidate: candidate(), application: application() });
    expect((await store.listCandidates()).find((c) => c.id === 'cand-new1')).toEqual(candidate());
    expect((await store.listApplications()).find((a) => a.id === 'app-new1')).toEqual(application());
  });

  it('a taken id writes nothing and answers null', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    const candidates = (await store.listCandidates()).length;
    const apps = (await store.listApplications()).length;
    expect(await store.createCandidate(candidate(), application('app-new2'))).toBeNull();
    expect(await store.createCandidate(candidate('cand-new2'), application())).toBeNull();
    expect([(await store.listCandidates()).length, (await store.listApplications()).length]).toEqual([candidates, apps]);
  });
});

// Gap audit 2026-11-20 (minor): a second opening for a candidate on record is one more application, never a second record.
describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(tablesExec()) as InterviewsStore],
])('the %s store\'s createApplication', (_name, make) => {
  const second = (id = 'app-new2', candidateId = 'cand-new1', openingId = 'op-ios'): Application => ({ ...application(id, candidateId), openingId });

  it('adds the application to the candidate on record and the list shows it; no candidate is added', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    const before = (await store.listCandidates()).length;
    expect(await store.createApplication(second())).toEqual(second());
    expect((await store.listApplications()).filter((a) => a.candidateId === 'cand-new1').map((a) => a.openingId).sort()).toEqual(['op-backend', 'op-ios']);
    expect((await store.listCandidates()).length).toBe(before);
  });

  it('a taken id, an unknown candidate and a candidate without an address write nothing and answer null', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    await store.createCandidate({ ...candidate('cand-blank'), email: '' }, application('app-blank', 'cand-blank'));
    const apps = (await store.listApplications()).length;
    expect(await store.createApplication(second('app-new1'))).toBeNull();
    expect(await store.createApplication(second('app-new3', 'cand-nobody'))).toBeNull();
    expect(await store.createApplication(second('app-new4', 'cand-blank'))).toBeNull();
    expect((await store.listApplications()).length).toBe(apps);
  });

  it('the opening already holding the address throws DuplicateCandidateError and writes nothing', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    const apps = (await store.listApplications()).length;
    await expect(store.createApplication(second('app-new5', 'cand-new1', 'op-backend'))).rejects.toBeInstanceOf(DuplicateCandidateError);
    expect((await store.listApplications()).length).toBe(apps);
  });
});

// Gap audit 2026-11-20 §6: the recruiter's edit, a compare-and-set on the candidate's version, in both stores alike.
describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(tablesExec()) as InterviewsStore],
])('the %s store\'s updateCandidate', (_name, make) => {
  const EDIT = { name: 'Nadia Novak', email: 'nadia.novak@mail.example', headline: 'Principal engineer', location: 'Brno' };
  const LATER = '2026-11-18T10:00:00.000Z';
  it('writes the four fields and the stamp against the version, and the list shows the same row', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    const out = await store.updateCandidate('cand-new1', EDIT, LATER, AT);
    const want = { ...candidate(), ...EDIT, updatedAt: LATER };
    expect(out).toEqual({ ok: true, row: want });
    expect((await store.listCandidates()).find((c) => c.id === 'cand-new1')).toEqual(want);
  });
  it('an old version is stale with the row as it now is; an unknown or erased candidate is not found', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    await store.updateCandidate('cand-new1', EDIT, LATER, AT);
    expect(await store.updateCandidate('cand-new1', { ...EDIT, name: 'Again' }, '2026-11-19T10:00:00.000Z', AT)).toEqual({ ok: false, reason: 'stale', row: { ...candidate(), ...EDIT, updatedAt: LATER } });
    expect(await store.updateCandidate('cand-none', EDIT, LATER, AT)).toEqual({ ok: false, reason: 'not-found' });
    await store.createCandidate({ ...candidate('cand-gone'), email: '' }, application('app-gone', 'cand-gone'));
    expect(await store.updateCandidate('cand-gone', EDIT, LATER, AT)).toEqual({ ok: false, reason: 'not-found' });
  });
  it('an address another candidate on the same opening holds is DuplicateCandidateError, and nothing changes', async () => {
    const store = make();
    await store.createCandidate(candidate(), application());
    await store.createCandidate({ ...candidate('cand-two'), email: 'other@mail.example' }, application('app-two', 'cand-two'));
    await expect(store.updateCandidate('cand-two', { ...EDIT, email: 'NADIA@mail.example' }, LATER, AT)).rejects.toBeInstanceOf(DuplicateCandidateError);
    expect((await store.listCandidates()).find((c) => c.id === 'cand-two')!.email).toBe('other@mail.example');
  });
});

describe('the statement and the schema', () => {
  it('the edit writes columns the schema has, adds updated_at idempotently, and moves the applications\' address key', () => {
    const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
    expect(schema).toContain('ALTER TABLE interview_candidates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;');
    expect(LIST_CANDIDATES_SQL).toContain('updated_at');
    expect(SqlInterviewsStore.UPDATE_CANDIDATE_SQL).toContain("UPDATE interview_applications SET email_key = lower(btrim(:email))");
  });
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  it('names only declared columns', () => {
    const cols = /INSERT INTO interview_candidates \(([^)]+)\)/.exec(SqlInterviewsStore.CREATE_CANDIDATE_SQL)![1]!.split(',').map((c) => c.trim());
    for (const col of cols) expect(schema).toMatch(new RegExp(`\\n  ${col}\\s`));
    expect(SqlInterviewsStore.CREATE_CANDIDATE_SQL).toContain('FROM c');
  });
  it('the application add names only declared columns, keys on the candidate\'s own address and skips one without', () => {
    const cols = /INSERT INTO interview_applications \(([^)]+)\)/.exec(SqlInterviewsStore.CREATE_APPLICATION_SQL)![1]!.split(',').map((c) => c.trim());
    for (const col of cols.filter((c) => c !== 'email_key')) expect(schema).toMatch(new RegExp(`\\n  ${col}\\s`));
    expect(SqlInterviewsStore.CREATE_APPLICATION_SQL).toContain('lower(btrim(c.email))');
    expect(SqlInterviewsStore.CREATE_APPLICATION_SQL).toContain("btrim(c.email) <> ''");
  });
});

// Hardening H5, finding 6: two adds of one address to one opening at once both passed the route's check. The schema now holds
// the rule (a unique index on the opening and the lower-cased address the application carries), and the SQL store turns
// that index's violation into DuplicateCandidateError, which the route answers with its 409 line.
describe('one person once per opening, held by the schema', () => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  it('the schema holds a unique index on the opening and the lower-cased address, and the add writes that address', () => {
    expect(schema).toContain('ALTER TABLE interview_applications ADD COLUMN IF NOT EXISTS email_key TEXT;');
    expect(schema).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS interview_applications_opening_email_key ON interview_applications \(opening_id, email_key\)\s+WHERE email_key IS NOT NULL;/);
    expect(SqlInterviewsStore.CREATE_CANDIDATE_SQL).toMatch(/history, email_key\)/);
    expect(SqlInterviewsStore.CREATE_CANDIDATE_SQL).toContain('lower(btrim(:email))');
  });
  it('the index\'s violation is thrown as DuplicateCandidateError; any other failure passes through unchanged', async () => {
    const dup = new SqlInterviewsStore(async () => { throw new Error('duplicate key value violates unique constraint "interview_applications_opening_email_key"'); });
    await expect(dup.createCandidate(candidate(), application())).rejects.toBeInstanceOf(DuplicateCandidateError);
    const other = new SqlInterviewsStore(async () => { throw new Error('connection reset'); });
    await expect(other.createCandidate(candidate(), application())).rejects.toThrow('connection reset');
  });
});
