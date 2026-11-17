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
      return [row];
    }
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

describe('the statement and the schema', () => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  it('names only declared columns', () => {
    const cols = /INSERT INTO interview_candidates \(([^)]+)\)/.exec(SqlInterviewsStore.CREATE_CANDIDATE_SQL)![1]!.split(',').map((c) => c.trim());
    for (const col of cols) expect(schema).toMatch(new RegExp(`\\n  ${col}\\s`));
    expect(SqlInterviewsStore.CREATE_CANDIDATE_SQL).toContain('FROM c');
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
