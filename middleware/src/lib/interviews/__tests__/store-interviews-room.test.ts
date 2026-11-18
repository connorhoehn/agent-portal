// The room's two writes (row I2.4; store.ts InterviewWrites startInterview / endInterview) behave the same in
// both stores: a compare-and-set on the interview's revision. The SQL store runs its real statements against a
// small stateful interviews table that answers the way the RDS Data API does; a last block holds the two
// statements to schema/interviews_schema.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewsFixture } from '../../../mock/interviews.js';
import { MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import { GET_INTERVIEW_SQL, LIST_INTERVIEWS_SQL, SqlInterviewsStore, type SqlExec } from '../store-sql.js';
import type { Interview } from '../types.js';

const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));
const AT = '2026-11-16T10:00:00.000Z';

const cells = (i: Interview): Record<string, unknown> => ({
  id: i.id, application_id: i.applicationId, round_id: i.roundId, type: i.type, lead_id: i.leadId, panel_ids: [...i.panelIds],
  scheduled_at: ts(i.scheduledAt), minutes: i.minutes, state: i.state, question_ids: [...i.questionIds], assigned_by: i.assignedBy,
  assigned_at: ts(i.assignedAt), call_id: i.callId, started_at: ts(i.startedAt ?? null), ended_at: ts(i.endedAt),
  acceptances: JSON.stringify(i.acceptances), declines: JSON.stringify(i.declines), revision: i.revision,
});

function roomTableExec(): SqlExec {
  const table = interviewsFixture.rows().map(cells);
  const bound = (params: SqlParameter[] = []) => new Map(params.map((p) => [p.name!, p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? null]));
  return async (sql, params) => {
    const b = bound(params);
    const find = () => table.find((r) => r['id'] === b.get('id'));
    if (sql === LIST_INTERVIEWS_SQL) return [...table];
    if (sql === GET_INTERVIEW_SQL) return find() ? [find()!] : [];
    if (sql === SqlInterviewsStore.START_INTERVIEW_SQL || sql === SqlInterviewsStore.END_INTERVIEW_SQL) {
      const row = find();
      if (!row || row['revision'] !== b.get('revision')) return [];
      if (sql === SqlInterviewsStore.START_INTERVIEW_SQL) { row['state'] = 'live'; if (b.get('started_at')) row['started_at'] = ts(String(b.get('started_at'))); }
      else { row['state'] = 'ended'; row['ended_at'] = ts(String(b.get('ended_at'))); }
      row['revision'] = Number(row['revision']) + 1;
      return [row];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
}

afterEach(() => fixtureRegistry.resetAll('default'));

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(roomTableExec()) as InterviewsStore],
])('the %s store\'s room writes', (_name, make) => {
  let store: InterviewsStore;
  beforeEach(() => { store = make(); });
  const read = async (id: string) => (await store.listInterviews()).find((i) => i.id === id)!;

  it('starts: the state goes live and the revision moves on; nothing else changes', async () => {
    const before = await read('iv-n5z9f2cq');
    const out = await store.startInterview(before.id, before.revision);
    expect(out).toEqual({ ok: true, row: { ...before, state: 'live', revision: before.revision + 1 } });
    expect(await read(before.id)).toEqual({ ...before, state: 'live', revision: before.revision + 1 });
  });

  it('starts with when it started: the record clock and header read it', async () => {
    const before = await read('iv-n5z9f2cq');
    const out = await store.startInterview(before.id, before.revision, AT);
    expect(out).toEqual({ ok: true, row: { ...before, state: 'live', startedAt: AT, revision: before.revision + 1 } });
    expect((await read(before.id)).startedAt).toBe(AT);
  });

  it('ends: the state goes ended with the time it ended', async () => {
    const before = await read('iv-n5z9f2cq');
    const started = await store.startInterview(before.id, before.revision);
    if (!started.ok) throw new Error('start failed');
    const out = await store.endInterview(before.id, AT, started.row.revision);
    expect(out).toEqual({ ok: true, row: { ...before, state: 'ended', endedAt: AT, revision: before.revision + 2 } });
  });

  it('a stale revision writes nothing and carries the row as it now is', async () => {
    const before = await read('iv-k1p5w8ra');
    expect(await store.startInterview(before.id, before.revision + 5)).toEqual({ ok: false, reason: 'stale', row: before });
    expect(await store.endInterview(before.id, AT, before.revision - 1)).toEqual({ ok: false, reason: 'stale', row: before });
    expect(await read(before.id)).toEqual(before);
  });

  it('an unknown interview is not found', async () => {
    expect(await store.startInterview('iv-nobody', 1)).toEqual({ ok: false, reason: 'not-found' });
    expect(await store.endInterview('iv-nobody', AT, 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('the room write statements match schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const body = /CREATE TABLE IF NOT EXISTS interviews \(([\s\S]*?)\n\);/.exec(ddl)![1]!;
  const cols = new Set(body.split('\n').map((l) => /^\s{2}([a-z_]+)\s+[A-Z]/.exec(l)?.[1]).filter((c): c is string => !!c));
  it.each([['start', SqlInterviewsStore.START_INTERVIEW_SQL], ['end', SqlInterviewsStore.END_INTERVIEW_SQL]])('%s names only declared columns', (_label, statement) => {
    const named = [
      ...[...statement.matchAll(/(\w+) = (?:CAST\(|')?:?\w/g)].map((m) => m[1]!),
      ...(/RETURNING ([\s\S]+)$/.exec(statement)?.[1]?.split(',') ?? []),
    ].map((c) => c.trim()).filter((c) => c !== 'revision + 1');
    expect(named).toEqual(expect.arrayContaining(['state', 'id', 'revision']));
    for (const c of named) expect([c, cols.has(c)]).toEqual([c, true]);
  });
});
