// The two interviews stores behave the same (docs/interviews-tenant-plan.md, row I0.3).
//
// One contract, run over both: the in-memory store reads the registered
// fixtures; the SQL store runs its real statements against an executor that
// answers each one with those same fixtures written the way the RDS Data API
// returns them (snake_case columns, TIMESTAMPTZ as '2026-11-16 10:00:00.000'
// text, JSONB as a JSON string, NUMERIC as a string, TEXT[] as string[],
// rows in no particular order unless the statement asks). Both must hand back
// identical records in identical order. A second block holds every statement
// to schema/interviews_schema.sql: each table it reads exists and each column
// it names is declared there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryInterviewsStore, ORDER, loadWorld, type InterviewsStore } from '../store.js';
import {
  INTERVIEWS_STATEMENTS, LIST_APPLICATIONS_SQL, LIST_CANDIDATES_SQL, LIST_INTERVIEWS_SQL, LIST_OPENINGS_SQL, LIST_SCORECARDS_SQL,
  SqlInterviewsStore, isoOf, type SqlExec,
} from '../store-sql.js';
import {
  interviewApplicationsFixture, interviewCandidatesFixture, interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture,
} from '../../../mock/interviews.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import type { InterviewsWorld } from '../types.js';

const ts = (iso: string | null) => (iso === null ? null : iso.replace('T', ' ').replace('Z', ''));
const shuffle = <T>(rows: T[]): T[] => rows.map((r, i) => [((i * 7919) % 13), r] as const).sort((a, b) => a[0] - b[0]).map(([, r]) => r);

/** The Data API's answer to each statement, from the same fixtures the memory store reads. */
function dataApiExec(sorted: boolean): { exec: SqlExec; seen: string[] } {
  const seen: string[] = [];
  const order = <T>(rows: T[], by: (a: T, b: T) => number) => (sorted ? [...rows].sort(by) : shuffle(rows));
  const exec: SqlExec = async (sql) => {
    seen.push(sql);
    if (sql === LIST_OPENINGS_SQL) return order(interviewOpeningsFixture.rows(), ORDER.openings).map((o) => ({
      id: o.id, title: o.title, level: o.level, team: o.team, location: o.location, hiring_manager_id: o.hiringManagerId,
      recruiter_id: o.recruiterId, state: o.state, opened_at: ts(o.openedAt), kit: JSON.stringify(o.kit),
      budget_cap_usd: o.budgetCapUsd === null ? null : o.budgetCapUsd.toFixed(2),
    }));
    if (sql === LIST_CANDIDATES_SQL) return order(interviewCandidatesFixture.rows(), ORDER.candidates).map((c) => ({
      id: c.id, name: c.name, email: c.email, headline: c.headline, location: c.location, source: c.source,
      resume_file_id: c.resumeFileId, notes: c.notes, created_at: ts(c.createdAt),
    }));
    if (sql === LIST_APPLICATIONS_SQL) return order(interviewApplicationsFixture.rows(), ORDER.applications).map((a) => ({
      id: a.id, candidate_id: a.candidateId, opening_id: a.openingId, stage: a.stage, applied_at: ts(a.appliedAt), history: JSON.stringify(a.history),
    }));
    if (sql === LIST_INTERVIEWS_SQL) return order(interviewsFixture.rows(), ORDER.interviews).map((i) => ({
      id: i.id, application_id: i.applicationId, round_id: i.roundId, type: i.type, lead_id: i.leadId, panel_ids: [...i.panelIds],
      scheduled_at: ts(i.scheduledAt), minutes: i.minutes, state: i.state, question_ids: [...i.questionIds], assigned_by: i.assignedBy,
      assigned_at: ts(i.assignedAt), invite_token_hash: i.inviteTokenHash, call_id: i.callId, ended_at: ts(i.endedAt),
    }));
    if (sql === LIST_SCORECARDS_SQL) return order(interviewScorecardsFixture.rows(), ORDER.scorecards).map((s) => ({
      id: s.id, interview_id: s.interviewId, interviewer_id: s.interviewerId, ratings: JSON.stringify(s.ratings), recommendation: s.recommendation,
      summary: s.summary, submitted_at: ts(s.submittedAt), version: s.version, changed_after_recap: s.changedAfterRecap,
    }));
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { exec, seen };
}

afterEach(() => fixtureRegistry.resetAll('default'));

describe.each([
  ['memory', () => new MemoryInterviewsStore() as InterviewsStore],
  ['sql', () => new SqlInterviewsStore(dataApiExec(true).exec) as InterviewsStore],
])('the %s store', (_name, make) => {
  let world: InterviewsWorld;
  beforeEach(async () => { world = await loadWorld(make()); });

  it('reads the seed story: three openings, twelve candidates and applications, eleven interviews, four scorecards', () => {
    expect(world.openings).toHaveLength(3);
    expect(world.candidates).toHaveLength(12);
    expect(world.applications).toHaveLength(12);
    expect(world.interviews).toHaveLength(11);
    expect(world.scorecards).toHaveLength(4);
  });

  it('returns each table in the statement\'s order', () => {
    expect(world.openings.map((o) => o.id)).toEqual(['op-em', 'op-ios', 'op-backend']);
    expect(world.candidates.map((c) => c.name)[0]).toBe('Aiko Tanaka');
    expect(world.interviews.map((i) => i.scheduledAt)).toEqual([...world.interviews.map((i) => i.scheduledAt)].sort());
  });

  it('keeps the kit, the history, the panel and the ratings whole', () => {
    const backend = world.openings.find((o) => o.id === 'op-backend')!;
    expect(backend.kit.rounds.map((r) => r.name)).toEqual(['Coding', 'System design', 'Working together']);
    expect(backend.kit.questions.find((q) => q.id === 'q-be-ratelimit')!.starter!.python).toContain('class RateLimiter');
    expect(world.applications.find((a) => a.id === 'app-ingrid')!.history.map((h) => h.stage)).toEqual(['applied', 'screening', 'interviewing', 'debrief']);
    expect(world.interviews.find((i) => i.id === 'iv-nadia-leadership')!.panelIds).toEqual(['u-hugo']);
    expect(world.scorecards.find((s) => s.id === 'sc-ingrid-coding')!.ratings.map((r) => r.rating)).toEqual([4, 4]);
    expect(world.openings.find((o) => o.id === 'op-ios')!.hiringManagerId).toBeNull();
  });
});

describe('the SQL store and the memory store agree', () => {
  it('row for row, field for field, in the same order', async () => {
    const mem = await loadWorld(new MemoryInterviewsStore());
    const sql = await loadWorld(new SqlInterviewsStore(dataApiExec(true).exec));
    expect(sql).toEqual(mem);
  });

  it('runs exactly its five statements, once each, and maps whatever order the rows arrive in', async () => {
    const { exec, seen } = dataApiExec(false);
    const sql = await loadWorld(new SqlInterviewsStore(exec));
    expect([...seen].sort()).toEqual([...INTERVIEWS_STATEMENTS].sort());
    const mem = await loadWorld(new MemoryInterviewsStore());
    expect(new Set(sql.interviews.map((i) => i.id))).toEqual(new Set(mem.interviews.map((i) => i.id)));
  });

  it('reads a Data API timestamp with or without an offset as the same instant', () => {
    expect(isoOf('2026-11-16 10:00:00')).toBe('2026-11-16T10:00:00.000Z');
    expect(isoOf('2026-11-16 11:00:00+01')).toBe('2026-11-16T10:00:00.000Z');
    expect(isoOf('2026-11-16T10:00:00.000Z')).toBe('2026-11-16T10:00:00.000Z');
  });

  it('the empty world is empty in both', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await loadWorld(new MemoryInterviewsStore())).toEqual(await loadWorld(new SqlInterviewsStore(dataApiExec(true).exec)));
    expect((await loadWorld(new MemoryInterviewsStore())).openings).toEqual([]);
  });
});

describe('every statement matches schema/interviews_schema.sql', () => {
  const ddl = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'schema', 'interviews_schema.sql'), 'utf8');
  const tables = new Map<string, Set<string>>();
  for (const m of ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
    const cols = new Set<string>();
    for (const line of m[2]!.split('\n')) {
      const c = /^\s{2}([a-z_]+)\s+[A-Z]/.exec(line);
      if (c && !['UNIQUE', 'PRIMARY', 'CHECK'].includes(c[1]!.toUpperCase())) cols.add(c[1]!);
    }
    tables.set(m[1]!, cols);
  }

  it('declares the five tables', () => {
    expect([...tables.keys()].sort()).toEqual(['interview_applications', 'interview_candidates', 'interview_openings', 'interview_scorecards', 'interviews']);
  });

  it.each(INTERVIEWS_STATEMENTS.map((s) => [s.split('\n')[0]!.slice(0, 60), s]))('%s… names only declared columns', (_label, statement) => {
    const table = /FROM (\w+)/.exec(statement)![1]!;
    const cols = /SELECT ([\s\S]+?)\s+FROM/.exec(statement)![1]!.split(',').map((c) => c.trim());
    expect(tables.has(table)).toBe(true);
    for (const c of cols) expect([table, c, tables.get(table)!.has(c)]).toEqual([table, c, true]);
    // ...and every declared column is read, so a column added to the table is a column the store maps.
    expect([...tables.get(table)!].sort()).toEqual([...cols].sort());
  });
});
