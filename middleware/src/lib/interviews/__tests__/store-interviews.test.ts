// The interview writes behave the same in both stores (docs/interviews-tenant-plan.md row I1.4; store.ts
// InterviewWrites). One contract over both: the memory store writes the registered fixture; the SQL store runs
// its real statements against a stateful interviews table that answers the way the RDS Data API does
// (snake_case, TIMESTAMPTZ as text, JSONB as a JSON string, TEXT[] as string[]). A last block holds the write
// statements to schema/interviews_schema.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { HUGO, WEN, interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import {
  ANSWER_SEAT_SQL, GET_INTERVIEW_SQL, INSERT_INTERVIEW_SQL, INTERVIEW_WRITE_STATEMENTS, LIST_INTERVIEWS_SQL, REASSIGN_SQL, SqlInterviewsStore, type SqlExec,
} from '../store-sql.js';
import { answerSeat, applyReassignment, newInterview } from '../assign.js';
import type { Interview } from '../types.js';

const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));
const AT = '2026-11-16T10:00:00.000Z';

const cells = (i: Interview): Record<string, unknown> => ({
  id: i.id, application_id: i.applicationId, round_id: i.roundId, type: i.type, lead_id: i.leadId, panel_ids: [...i.panelIds],
  scheduled_at: ts(i.scheduledAt), minutes: i.minutes, state: i.state, question_ids: [...i.questionIds], assigned_by: i.assignedBy,
  assigned_at: ts(i.assignedAt), invite_token_hash: i.inviteTokenHash, call_id: i.callId, ended_at: ts(i.endedAt),
  acceptances: JSON.stringify(i.acceptances), declines: JSON.stringify(i.declines), revision: i.revision,
});

/** A stateful interviews table over the Data API, running the store's write statements by their bound parameters. */
function interviewsTableExec(): { exec: SqlExec; seen: string[] } {
  const table = interviewsFixture.rows().map(cells);
  const seen: string[] = [];
  const bound = (params: SqlParameter[] = []) => new Map(params.map((p) => [p.name!, p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? null]));
  const exec: SqlExec = async (sql, params) => {
    seen.push(sql);
    const b = bound(params);
    const find = () => table.find((r) => r['id'] === b.get('id'));
    const arr = (name: string) => JSON.parse(String(b.get(name))) as string[];
    if (sql === LIST_INTERVIEWS_SQL) {
      return [...table].sort((x, y) => (x['scheduled_at'] === null ? 1 : 0) - (y['scheduled_at'] === null ? 1 : 0)
        || String(x['scheduled_at'] ?? '').localeCompare(String(y['scheduled_at'] ?? '')) || String(x['id']).localeCompare(String(y['id'])));
    }
    if (sql === GET_INTERVIEW_SQL) return find() ? [find()!] : [];
    if (sql === INSERT_INTERVIEW_SQL) {
      if (find()) return [];
      const at = (n: string) => (b.get(n) === null ? null : ts(String(b.get(n))));
      const row = {
        id: b.get('id'), application_id: b.get('application_id'), round_id: b.get('round_id'), type: b.get('type'), lead_id: b.get('lead_id'),
        panel_ids: arr('panel_ids'), scheduled_at: at('scheduled_at'), minutes: b.get('minutes'), state: b.get('state'), question_ids: arr('question_ids'),
        assigned_by: b.get('assigned_by'), assigned_at: at('assigned_at'), invite_token_hash: b.get('invite_token_hash'), call_id: b.get('call_id'),
        ended_at: at('ended_at'), acceptances: b.get('acceptances'), declines: b.get('declines'), revision: 1,
      };
      table.push(row);
      return [row];
    }
    if (sql === ANSWER_SEAT_SQL || sql === REASSIGN_SQL) {
      const row = find();
      if (!row || row['revision'] !== b.get('revision')) return [];
      row['state'] = b.get('state');
      row['panel_ids'] = arr('panel_ids');
      row['acceptances'] = b.get('acceptances');
      if (sql === ANSWER_SEAT_SQL) row['declines'] = b.get('declines');
      else row['lead_id'] = b.get('lead_id');
      row['revision'] = Number(row['revision']) + 1;
      return [row];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { exec, seen };
}

const opening = () => interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!;
const NEW = (): Interview => newInterview({ applicationId: 'app-lucia', roundId: 'rd-coding', leadId: HUGO, panelIds: [WEN] }, opening(), 'iv-k3v9q2m8x1zt', 'u-greta', AT);

afterEach(() => fixtureRegistry.resetAll('default'));

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(interviewsTableExec().exec) as InterviewsStore],
])('the %s store\'s interview writes', (_name, make) => {
  let store: InterviewsStore;
  beforeEach(() => { store = make(); });
  const read = async (id: string) => (await store.listInterviews()).find((i) => i.id === id)!;

  it('creates an interview at revision 1, with no time, and reads it back whole and last', async () => {
    const created = await store.createInterview(NEW());
    expect(created).toEqual(NEW());
    const listed = await store.listInterviews();
    expect(listed[listed.length - 1]).toEqual(created);
  });

  it('a taken id creates nothing', async () => {
    expect(await store.createInterview({ ...NEW(), id: 'iv-kwame-coding' })).toBeNull();
    expect((await read('iv-kwame-coding')).applicationId).toBe('app-kwame');
  });

  it('answers a seat at the revision it was made against, and bumps it', async () => {
    const before = await read('iv-kwame-coding');
    const out = answerSeat(before, HUGO, { answer: 'decline', reason: 'On leave that whole week.' }, AT);
    if (!out.ok) throw new Error(out.message);
    const r = await store.answerSeat('iv-kwame-coding', out.change, 1);
    expect(r).toMatchObject({ ok: true, row: { state: 'declined', revision: 2, declines: [{ userId: HUGO, seat: 'lead', reason: 'On leave that whole week.', at: AT }] } });
    expect(await read('iv-kwame-coding')).toEqual((r as { row: Interview }).row);
  });

  it('reassigns: the lead, the panel, the state and the acceptances; the declines stay', async () => {
    const before = await read('iv-kwame-coding');
    const out = answerSeat(before, HUGO, { answer: 'decline', reason: 'On leave that whole week.' }, AT);
    if (!out.ok) throw new Error(out.message);
    await store.answerSeat(before.id, out.change, 1);
    const declined = await read(before.id);
    const r = await store.reassign(before.id, applyReassignment(declined, { leadId: WEN, panelIds: [HUGO] }), 2);
    expect(r).toMatchObject({ ok: true, row: { leadId: WEN, panelIds: [HUGO], state: 'assigned', acceptances: [], revision: 3, declines: [{ userId: HUGO }] } });
    expect((await read(before.id)).scheduledAt).toBe(before.scheduledAt);
  });

  it('a stale revision writes nothing and answers the row as it now is; an unknown id is not found', async () => {
    const before = await read('iv-ravi-together');
    const accept = answerSeat(before, WEN, { answer: 'accept' }, AT);
    if (!accept.ok) throw new Error(accept.message);
    expect((await store.answerSeat(before.id, accept.change, 1)).ok).toBe(true);
    const stale = await store.answerSeat(before.id, accept.change, 1);
    expect(stale).toMatchObject({ ok: false, reason: 'stale', row: { id: before.id, state: 'accepted', revision: 2 } });
    expect(await store.reassign(before.id, applyReassignment(before, { leadId: HUGO, panelIds: [] }), 1)).toMatchObject({ ok: false, reason: 'stale' });
    expect((await read(before.id)).leadId).toBe(WEN);
    expect(await store.answerSeat('iv-nowhere', accept.change, 1)).toEqual({ ok: false, reason: 'not-found' });
    expect(await store.reassign('iv-nowhere', applyReassignment(before, { leadId: HUGO, panelIds: [] }), 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('the two stores agree after the same interview writes', () => {
  it('row for row, field for field', async () => {
    const mem = new MemoryInterviewsStore();
    const sql = new SqlInterviewsStore(interviewsTableExec().exec);
    const results: Interview[][] = [];
    for (const s of [mem, sql] as InterviewsStore[]) {
      fixtureRegistry.resetAll('default');
      await s.createInterview(NEW());
      const created = (await s.listInterviews()).find((i) => i.id === NEW().id)!;
      const out = answerSeat(created, WEN, { answer: 'decline', reason: 'I interviewed this person last year.' }, AT);
      if (!out.ok) throw new Error(out.message);
      await s.answerSeat(created.id, out.change, 1);
      await s.reassign(created.id, { leadId: HUGO, panelIds: ['u-third'], state: 'assigned', acceptances: [] }, 2);
      await s.reassign(created.id, { leadId: HUGO, panelIds: [], state: 'assigned', acceptances: [] }, 2);
      // The seed's instants are computed from the clock at each reset, so the written row is compared whole and the rest by id.
      const listed = await s.listInterviews();
      results.push([listed.find((i) => i.id === created.id)!, ...listed.map((i) => ({ id: i.id }) as Interview)]);
    }
    expect(results[1]).toEqual(results[0]);
  });

  it('a compare-and-set that writes runs one statement; one that loses reads the row once to say why', async () => {
    const { exec, seen } = interviewsTableExec();
    const sql = new SqlInterviewsStore(exec);
    const change = { leadId: WEN, panelIds: [], state: 'assigned' as const, acceptances: [] };
    await sql.reassign('iv-kwame-coding', change, 1);
    expect(seen).toEqual([REASSIGN_SQL]);
    await sql.reassign('iv-kwame-coding', change, 1);
    expect(seen).toEqual([REASSIGN_SQL, REASSIGN_SQL, GET_INTERVIEW_SQL]);
  });
});

describe('the interview write statements match schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const body = /CREATE TABLE IF NOT EXISTS interviews \(([\s\S]*?)\n\);/.exec(ddl)![1]!;
  const cols = new Set(body.split('\n').map((l) => /^\s{2}([a-z_]+)\s+[A-Z]/.exec(l)?.[1]).filter((c): c is string => !!c));

  it.each(INTERVIEW_WRITE_STATEMENTS.map((s) => [s.split('\n')[0]!.slice(0, 60), s]))('%s… names only declared columns', (_label, statement) => {
    const named = [
      ...(/INSERT INTO interviews \(([^)]+)\)/.exec(statement)?.[1]?.split(',') ?? []),
      ...[...statement.matchAll(/(\w+) = (?:CAST\(|ARRAY\()?:?\w/g)].map((m) => m[1]!),
      ...(/RETURNING ([\s\S]+)$/.exec(statement)?.[1]?.split(',') ?? []),
      ...(/SELECT ([\s\S]+?)\s+FROM interviews/.exec(statement)?.[1]?.split(',') ?? []),
    ].map((c) => c.trim()).filter((c) => c !== 'revision + 1');
    expect(named.length).toBeGreaterThan(1);
    for (const c of named) expect([c, cols.has(c)]).toEqual([c, true]);
    if (statement.startsWith('INSERT')) expect(/INSERT INTO interviews \(([^)]+)\)/.exec(statement)![1]!.split(',').map((c) => c.trim()).sort()).toEqual([...cols].sort());
  });
});
