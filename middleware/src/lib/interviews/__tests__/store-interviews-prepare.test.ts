// The chosen-questions write behaves the same in both stores (row I1.7; store.ts InterviewWrites.setQuestions).
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewsFixture } from '../../../mock/interviews.js';
import { MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import { GET_INTERVIEW_SQL, SET_QUESTIONS_SQL, SqlInterviewsStore, type SqlExec } from '../store-sql.js';

function tableExec(): SqlExec {
  const table = interviewsFixture.rows().map((i) => ({
    id: i.id, application_id: i.applicationId, round_id: i.roundId, type: i.type, lead_id: i.leadId, panel_ids: [...i.panelIds],
    scheduled_at: i.scheduledAt, minutes: i.minutes, state: i.state, question_ids: [...i.questionIds], assigned_by: i.assignedBy,
    assigned_at: i.assignedAt, invite_token_hash: null, call_id: null, ended_at: null, acceptances: JSON.stringify(i.acceptances),
    declines: JSON.stringify(i.declines), revision: i.revision,
  }) as Record<string, unknown>);
  return async (sql: string, params: SqlParameter[] = []) => {
    const b = new Map(params.map((p) => [p.name!, p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? null]));
    const row = table.find((r) => r['id'] === b.get('id'));
    if (sql === GET_INTERVIEW_SQL) return row ? [row] : [];
    if (sql === SET_QUESTIONS_SQL) {
      if (!row || row['revision'] !== b.get('revision')) return [];
      row['question_ids'] = JSON.parse(String(b.get('question_ids'))) as string[];
      row['state'] = b.get('state');
      row['revision'] = Number(row['revision']) + 1;
      return [row];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
}

afterEach(() => fixtureRegistry.resetAll('default'));

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(tableExec()) as InterviewsStore],
])('the %s store\'s question write', (_name, make) => {
  let store: InterviewsStore;
  beforeEach(() => { store = make(); });

  it('stores the questions in order and the state, bumps the revision, and reads back the same', async () => {
    const r = await store.setQuestions('iv-nadia-design', ['q-be-retry', 'q-be-ledger'], 'accepted', 1);
    expect(r).toMatchObject({ ok: true, row: { questionIds: ['q-be-retry', 'q-be-ledger'], state: 'accepted', revision: 2 } });
    if (_name === 'memory') expect((await store.listInterviews()).find((i) => i.id === 'iv-nadia-design')).toEqual((r as { row: unknown }).row);
  });

  it('a stale revision writes nothing and answers the row as it is; an unknown id is not found', async () => {
    await store.setQuestions('iv-nadia-design', ['q-be-retry'], 'ready', 1);
    const stale = await store.setQuestions('iv-nadia-design', ['q-be-ledger'], 'accepted', 1);
    expect(stale).toMatchObject({ ok: false, reason: 'stale', row: { questionIds: ['q-be-retry'], state: 'ready', revision: 2 } });
    expect(await store.setQuestions('iv-nope', [], 'accepted', 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});
