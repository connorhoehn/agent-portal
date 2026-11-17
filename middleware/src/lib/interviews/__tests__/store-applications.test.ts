// The stage decision's writes (row I5.5; store.ts ApplicationWrites decideStage, InterviewWrites markReviewed) behave the
// same in both stores. The SQL store runs its real statements against small stateful tables that answer the way the RDS
// Data API does; a last block holds the statements to schema/interviews_schema.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewApplicationsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import { GET_INTERVIEW_SQL, LIST_APPLICATIONS_SQL, LIST_INTERVIEWS_SQL, SqlInterviewsStore, type SqlExec } from '../store-sql.js';
import type { Application, Interview, StageChange } from '../types.js';

const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));

const interviewCells = (i: Interview): Record<string, unknown> => ({
  id: i.id, application_id: i.applicationId, round_id: i.roundId, type: i.type, lead_id: i.leadId, panel_ids: [...i.panelIds],
  scheduled_at: ts(i.scheduledAt), minutes: i.minutes, state: i.state, question_ids: [...i.questionIds], assigned_by: i.assignedBy,
  assigned_at: ts(i.assignedAt), call_id: i.callId, ended_at: ts(i.endedAt),
  acceptances: JSON.stringify(i.acceptances), declines: JSON.stringify(i.declines), revision: i.revision,
});
const applicationCells = (a: Application): Record<string, unknown> => ({
  id: a.id, candidate_id: a.candidateId, opening_id: a.openingId, stage: a.stage, applied_at: ts(a.appliedAt), history: JSON.stringify(a.history),
});

function tablesExec(): SqlExec {
  const interviews = interviewsFixture.rows().map(interviewCells);
  const apps = interviewApplicationsFixture.rows().map(applicationCells);
  const bound = (params: SqlParameter[] = []) => new Map(params.map((p) => [p.name!,
    p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? p.value!.booleanValue ?? null]));
  return async (sql, params) => {
    const b = bound(params);
    if (sql === LIST_INTERVIEWS_SQL) return [...interviews];
    if (sql === LIST_APPLICATIONS_SQL) return [...apps];
    if (sql === GET_INTERVIEW_SQL) return interviews.filter((r) => r['id'] === b.get('id'));
    if (sql === SqlInterviewsStore.GET_APPLICATION_SQL) return apps.filter((r) => r['id'] === b.get('id'));
    if (sql === SqlInterviewsStore.MARK_REVIEWED_SQL) {
      const row = interviews.find((r) => r['id'] === b.get('id'));
      if (!row || row['revision'] !== b.get('revision')) return [];
      row['state'] = 'reviewed';
      row['revision'] = Number(row['revision']) + 1;
      return [row];
    }
    if (sql === SqlInterviewsStore.DECIDE_STAGE_SQL) {
      const row = apps.find((r) => r['id'] === b.get('id'));
      const history = row ? JSON.parse(String(row['history'])) as unknown[] : [];
      if (!row || history.length !== b.get('based_on')) return [];
      row['history'] = JSON.stringify([...history, ...(JSON.parse(String(b.get('change'))) as unknown[])]);
      row['stage'] = b.get('stage');
      return [row];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
}

afterEach(() => fixtureRegistry.resetAll('default'));

const INGRID = 'app-ingrid';
const decision = (over: Partial<StageChange & { decision: string; scorecardsMissing: number }> = {}) => ({
  stage: 'offer' as const, at: '2026-11-16T10:00:00.000Z', by: 'u-amara', reason: 'Both rounds were strong on the things this team needs.',
  decision: 'advance', scorecardsMissing: 0, ...over,
});

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(tablesExec()) as InterviewsStore],
])('the %s store\'s stage decision', (_name, make) => {
  let store: InterviewsStore;
  beforeEach(() => { store = make(); });
  const ingrid = async () => (await store.listApplications()).find((a) => a.id === INGRID)!;

  it('appends the decision whole, moves the stage, and keeps every earlier entry unchanged', async () => {
    const before = await ingrid();
    const out = await store.decideStage(INGRID, decision(), before.history.length);
    expect(out).toEqual({ ok: true, row: { ...before, stage: 'offer', history: [...before.history, decision()] } });
    expect(await ingrid()).toEqual({ ...before, stage: 'offer', history: [...before.history, decision()] });
  });

  it('a later decision is a new entry; one made against an old length is stale with the application as it now is', async () => {
    const n = (await ingrid()).history.length;
    await store.decideStage(INGRID, decision({ stage: 'on-hold', decision: 'hold' }), n);
    const late = await store.decideStage(INGRID, decision({ stage: 'rejected', decision: 'reject' }), n);
    expect(late).toMatchObject({ ok: false, reason: 'stale', row: { stage: 'on-hold' } });
    expect(await store.decideStage(INGRID, decision(), n + 1)).toMatchObject({ ok: true, row: { stage: 'offer' } });
    expect((await ingrid()).history.slice(n).map((h) => h.stage)).toEqual(['on-hold', 'offer']);
  });

  it('an unknown application is not found', async () => {
    expect(await store.decideStage('app-nobody', decision(), 1)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('marks an interview reviewed at the revision it was made against, and bumps it', async () => {
    const before = (await store.listInterviews()).find((i) => i.id === 'iv-d7q4n9xe')!;
    expect(before.state).toBe('scored');
    expect(await store.markReviewed(before.id, before.revision)).toEqual({ ok: true, row: { ...before, state: 'reviewed', revision: before.revision + 1 } });
    expect(await store.markReviewed(before.id, before.revision)).toMatchObject({ ok: false, reason: 'stale', row: { state: 'reviewed' } });
    expect(await store.markReviewed('iv-nobody', 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('the decision statements and the schema', () => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  it('name only declared columns; the history is the JSONB array the append extends', () => {
    for (const col of SqlInterviewsStore.APPLICATION_COLUMNS.split(', ')) expect(schema).toMatch(new RegExp(`\\n  ${col}\\s`));
    expect(schema).toMatch(/\n {2}history\s+JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(SqlInterviewsStore.DECIDE_STAGE_SQL).toContain('jsonb_array_length(history) = :based_on');
    expect(schema).toMatch(/'reviewed'/);
  });
});
