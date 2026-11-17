// The scorecard's writes (row I5.3; store.ts ScorecardWrites addScorecardVersion, InterviewWrites markScored) behave
// the same in both stores. The SQL store runs its real statements against small stateful tables that answer the
// way the RDS Data API does; a last block holds the statements to schema/interviews_schema.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { interviewScorecardsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { MemoryInterviewsStore, type InterviewsStore } from '../store.js';
import { GET_INTERVIEW_SQL, LIST_INTERVIEWS_SQL, LIST_SCORECARDS_SQL, SqlInterviewsStore, type SqlExec } from '../store-sql.js';
import type { Interview, Scorecard } from '../types.js';

const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));
const AT = '2026-11-16T10:00:00.000Z';

const interviewCells = (i: Interview): Record<string, unknown> => ({
  id: i.id, application_id: i.applicationId, round_id: i.roundId, type: i.type, lead_id: i.leadId, panel_ids: [...i.panelIds],
  scheduled_at: ts(i.scheduledAt), minutes: i.minutes, state: i.state, question_ids: [...i.questionIds], assigned_by: i.assignedBy,
  assigned_at: ts(i.assignedAt), call_id: i.callId, ended_at: ts(i.endedAt),
  acceptances: JSON.stringify(i.acceptances), declines: JSON.stringify(i.declines), revision: i.revision,
});
const scorecardCells = (s: Scorecard): Record<string, unknown> => ({
  id: s.id, interview_id: s.interviewId, interviewer_id: s.interviewerId, ratings: JSON.stringify(s.ratings), recommendation: s.recommendation,
  summary: s.summary, submitted_at: ts(s.submittedAt), version: s.version, changed_after_recap: s.changedAfterRecap, correction_reason: s.correctionReason,
});

function tablesExec(): SqlExec {
  const interviews = interviewsFixture.rows().map(interviewCells);
  const cards = interviewScorecardsFixture.rows().map(scorecardCells);
  const bound = (params: SqlParameter[] = []) => new Map(params.map((p) => [p.name!,
    p.value!.isNull ? null : p.value!.stringValue ?? p.value!.longValue ?? p.value!.booleanValue ?? null]));
  return async (sql, params) => {
    const b = bound(params);
    if (sql === LIST_INTERVIEWS_SQL) return [...interviews];
    if (sql === LIST_SCORECARDS_SQL) return [...cards].sort((x, y) => String(x['submitted_at']).localeCompare(String(y['submitted_at'])) || String(x['id']).localeCompare(String(y['id'])));
    if (sql === GET_INTERVIEW_SQL) return interviews.filter((r) => r['id'] === b.get('id'));
    if (sql === SqlInterviewsStore.MARK_SCORED_SQL) {
      const row = interviews.find((r) => r['id'] === b.get('id'));
      if (!row || row['revision'] !== b.get('revision')) return [];
      row['state'] = 'scored';
      row['revision'] = Number(row['revision']) + 1;
      return [row];
    }
    const mine = () => cards.filter((r) => r['interview_id'] === b.get('interview_id') && r['interviewer_id'] === b.get('interviewer_id'));
    if (sql === SqlInterviewsStore.INSERT_SCORECARD_VERSION_SQL) {
      const latest = mine().reduce((n, r) => Math.max(n, Number(r['version'])), 0);
      if (latest !== Number(b.get('version')) - 1 || cards.some((r) => r['id'] === b.get('id'))) return [];
      const row = {
        id: b.get('id'), interview_id: b.get('interview_id'), interviewer_id: b.get('interviewer_id'), ratings: b.get('ratings'), recommendation: b.get('recommendation'),
        summary: b.get('summary'), submitted_at: ts(String(b.get('submitted_at'))), version: b.get('version'), changed_after_recap: b.get('changed_after_recap'),
        correction_reason: b.get('correction_reason'),
      };
      cards.push(row);
      return [row];
    }
    if (sql === SqlInterviewsStore.LATEST_SCORECARD_SQL) return mine().sort((x, y) => Number(y['version']) - Number(x['version'])).slice(0, 1);
    throw new Error(`unexpected statement: ${sql}`);
  };
}

afterEach(() => fixtureRegistry.resetAll('default'));

const JONAH = 'iv-g9r1y8lp';
const first = (over: Partial<Scorecard> = {}): Scorecard => ({
  id: 'sc-new-1', interviewId: JONAH, interviewerId: 'u-wen', recommendation: 'yes', summary: 'Grounded examples.', submittedAt: AT, version: 1,
  changedAfterRecap: false, correctionReason: null,
  ratings: [{ competencyId: 'coaching', rating: 3, note: 'Specific about the plan.' }], ...over,
});

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(tablesExec()) as InterviewsStore],
])('the %s store\'s scorecard writes', (_name, make) => {
  let store: InterviewsStore;
  beforeEach(() => { store = make(); });
  const versions = async () => (await store.listScorecards()).filter((s) => s.interviewId === JONAH).map((s) => [s.id, s.version, s.correctionReason]);

  it('submits a first version and reads it back whole', async () => {
    const out = await store.addScorecardVersion(first());
    expect(out).toEqual({ ok: true, row: first() });
    expect((await store.listScorecards()).find((s) => s.id === 'sc-new-1')).toEqual(first());
  });

  it('a correction is a new version beside the first, with its reason; the first is kept unchanged', async () => {
    await store.addScorecardVersion(first());
    const v2 = first({ id: 'sc-new-2', version: 2, recommendation: 'strong-yes', correctionReason: 'I misread my own note on coaching.', submittedAt: '2026-11-16T11:00:00.000Z' });
    expect(await store.addScorecardVersion(v2)).toEqual({ ok: true, row: v2 });
    expect(await versions()).toEqual([['sc-new-1', 1, null], ['sc-new-2', 2, 'I misread my own note on coaching.']]);
  });

  it('a second first version, or a correction against an old version, is stale with the latest as it now is', async () => {
    await store.addScorecardVersion(first());
    expect(await store.addScorecardVersion(first({ id: 'sc-other' }))).toEqual({ ok: false, reason: 'stale', row: first() });
    await store.addScorecardVersion(first({ id: 'sc-new-2', version: 2, correctionReason: 'r' }));
    const late = await store.addScorecardVersion(first({ id: 'sc-new-2b', version: 2, correctionReason: 'r' }));
    expect(late).toMatchObject({ ok: false, reason: 'stale', row: { id: 'sc-new-2', version: 2 } });
    expect(await versions()).toEqual([['sc-new-1', 1, null], ['sc-new-2', 2, 'r']]);
  });

  it('a version with nothing before it is not found', async () => {
    expect(await store.addScorecardVersion(first({ version: 3 }))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('marks an interview scored at the revision it was made against, and bumps it', async () => {
    const before = (await store.listInterviews()).find((i) => i.id === JONAH)!;
    expect(await store.markScored(JONAH, before.revision)).toEqual({ ok: true, row: { ...before, state: 'scored', revision: before.revision + 1 } });
    expect(await store.markScored(JONAH, before.revision)).toMatchObject({ ok: false, reason: 'stale', row: { state: 'scored' } });
    expect(await store.markScored('iv-nobody', 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('the scorecard statements and the schema', () => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  it('names only declared columns, and the correction reason is declared for a database made before it', () => {
    for (const col of SqlInterviewsStore.SCORECARD_COLUMNS.split(', ')) expect(schema).toMatch(new RegExp(`\\n  ${col}\\s`));
    expect(schema).toContain('ALTER TABLE interview_scorecards ADD COLUMN IF NOT EXISTS correction_reason TEXT;');
    expect(schema).toContain('UNIQUE (interview_id, interviewer_id, version)');
  });
});
