// Who reads which interviews rows (docs/interviews-tenant-plan.md, decision 2; row I0.5), over the
// seed story in mock/interviews.ts, and the wire shapes built from what each viewer may read.
import { MemoryInterviewsStore, loadWorld } from '../store.js';
import { reachOf, visibleWorld } from '../scope.js';
import { WorldIndex, bucketFor, type People } from '../views.js';
import { debriefView } from '../debrief/view.js';
import type { InterviewsWorld } from '../types.js';

const NAMES: Record<string, string> = { 'u-greta': 'Greta Lindqvist', 'u-hugo': 'Hugo Marchetti', 'u-wen': 'Wen Zhao', 'u-amara': 'Amara Okafor' };
const people: People = (id) => ({ id, name: NAMES[id] ?? 'Someone without an account here' });

let world: InterviewsWorld;
beforeAll(async () => { world = await loadWorld(new MemoryInterviewsStore()); });

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id).sort();
const as = (id: string, role: string) => visibleWorld(world, { id, role });

describe('reach by role', () => {
  it('recruiter and admin read everything; interviewer what is assigned; hiring manager their openings; anyone else nothing', () => {
    expect(['recruiter', 'admin', 'interviewer', 'hiring-manager', 'member', 'requester', ''].map(reachOf))
      .toEqual(['everything', 'everything', 'assigned', 'own-openings', 'nothing', 'nothing', 'nothing']);
  });

  it('the recruiter reads the whole desk', () => {
    expect(as('u-greta', 'recruiter')).toEqual(world);
  });

  it('a role from another tenant reads nothing, even with an id that leads interviews', () => {
    const w = as('u-hugo', 'member');
    expect([w.openings, w.candidates, w.applications, w.interviews, w.scorecards].every((t) => t.length === 0)).toBe(true);
  });
});

describe('an interviewer', () => {
  it('reads the interviews they lead or sit on the panel of, and nothing of another interviewer\'s', () => {
    expect(ids(as('u-hugo', 'interviewer').interviews)).toEqual(
      ['iv-d7q4n9xe', 'iv-h4m7c3vu', 'iv-j6x2d9sb', 'iv-k1p5w8ra', 'iv-m8t3h6ng', 'iv-n5z9f2cq', 'iv-s4e8u2zk']);
    expect(ids(as('u-hugo', 'interviewer').interviews)).not.toContain('iv-c3k8w2ma');
    expect(ids(as('u-wen', 'interviewer').interviews)).toEqual(
      ['iv-c3k8w2ma', 'iv-f2b6t5zh', 'iv-g9r1y8lp', 'iv-n5z9f2cq', 'iv-p2v7j4ye', 'iv-r6d1k9wt', 'iv-s4e8u2zk']);
  });

  it('reads, through those interviews, only those candidates and openings', () => {
    const hugo = as('u-hugo', 'interviewer');
    expect(hugo.candidates.map((c) => c.name).sort()).toEqual(['Ingrid Solberg', 'Kwame Asante', 'Mateo Álvarez', 'Nadia Petrova']);
    expect(ids(hugo.openings)).toEqual(['op-backend', 'op-em']);
    expect(ids(as('u-wen', 'interviewer').openings)).toEqual(['op-backend', 'op-em', 'op-ios']);
  });

  it('reads a colleague\'s scorecards on a candidate only once their own for every round they sit on there is in (row I5.3)', () => {
    // Ingrid: Hugo's coding and Wen's working-together are both in, so each reads the other's.
    // Mateo: Hugo's coding is in but he also leads the design round, still to run: nobody else's (there are none yet either).
    expect(ids(as('u-hugo', 'interviewer').scorecards)).toEqual(['sc-ju3s5t85', 'sc-qadtme79', 'sc-szbsws4n']);
    expect(ids(as('u-wen', 'interviewer').scorecards)).toEqual(['sc-b75vwqbq', 'sc-ju3s5t85', 'sc-szbsws4n']);
  });
});

describe('a hiring manager', () => {
  it('reads their own openings and what hangs off them, never an opening that is not theirs', () => {
    const amara = as('u-amara', 'hiring-manager');
    expect(ids(amara.openings)).toEqual(['op-backend', 'op-em']);
    expect(amara.candidates).toHaveLength(8);
    expect(amara.candidates.map((c) => c.name)).not.toContain('Aiko Tanaka');
    expect(ids(amara.interviews)).not.toContain('iv-p2v7j4ye');
    expect(ids(amara.scorecards)).toEqual(['sc-ju3s5t85', 'sc-qadtme79', 'sc-szbsws4n']);
  });

  it('another hiring manager reads none of them', () => {
    const other = as('u-someone-else', 'hiring-manager');
    expect(other.openings).toEqual([]);
    expect(other.interviews).toEqual([]);
  });
});

describe('the wire shapes', () => {
  const index = (id: string, role: string) => new WorldIndex(as(id, role), people, { id, role });

  it('the recruiter\'s candidates table: one row per application with the opening, stage, next interview and last result', () => {
    const rows = index('u-greta', 'recruiter').candidateRows();
    expect(rows).toHaveLength(12);
    const mateo = rows.find((r) => r.candidate.name === 'Mateo Álvarez')!;
    expect(mateo.opening.title).toBe('Senior Backend Engineer');
    expect(mateo.stage).toBe('interviewing');
    expect(mateo.nextInterview).toMatchObject({ roundName: 'Coding', state: 'ready', lead: { name: 'Hugo Marchetti' } });
    expect(mateo.lastResult).toMatchObject({ recommendation: 'yes', roundName: 'Coding', interviewer: { name: 'Hugo Marchetti' } });
    expect([mateo.roundsDone, mateo.roundsTotal]).toEqual([1, 3]);
    const ingrid = rows.find((r) => r.candidate.name === 'Ingrid Solberg')!;
    expect(ingrid.lastResult).toMatchObject({ roundName: 'Working together', interviewer: { name: 'Wen Zhao' } });
    expect(rows.find((r) => r.candidate.name === 'Jonah Whitaker')!.scorecardDue).toBe(true);
    expect(rows.filter((r) => r.nextInterview).length).toBe(5);
  });

  it('the last result is only ever a scorecard the viewer may read', () => {
    const hugo = index('u-hugo', 'interviewer').candidateRows();
    expect(hugo.find((r) => r.candidate.name === 'Ingrid Solberg')!.lastResult).toMatchObject({ roundName: 'Coding', interviewer: { name: 'Hugo Marchetti' } });
  });

  it('an interviewer\'s desk: to accept, to prepare, upcoming, scorecards due, done', () => {
    const desk = (id: string) => {
      const out: Record<string, string[]> = {};
      for (const r of index(id, 'interviewer').interviewRows()) (out[r.bucket] ??= []).push(r.candidate.name);
      return out;
    };
    expect(desk('u-hugo')).toEqual({
      'done': ['Ingrid Solberg', 'Mateo Álvarez'],
      'upcoming': ['Kwame Asante', 'Mateo Álvarez', 'Nadia Petrova'],
      'to-prepare': ['Nadia Petrova'],
      'to-accept': ['Kwame Asante'],
    });
    expect(desk('u-wen')).toEqual({
      'done': ['Ingrid Solberg', 'Ravi Menon'],
      'scorecard-due': ['Jonah Whitaker'],
      'upcoming': ['Kwame Asante', 'Aiko Tanaka'],
      'to-prepare': ['Nadia Petrova'],
      'to-accept': ['Ravi Menon'],
    });
  });

  it('a panel seat reads as panel, the lead as lead', () => {
    const rows = index('u-hugo', 'interviewer').interviewRows();
    expect(rows.find((r) => r.id === 'iv-n5z9f2cq')!).toMatchObject({ seat: 'panel', lead: { name: 'Wen Zhao' }, panel: [{ name: 'Hugo Marchetti' }] });
    expect(rows.find((r) => r.id === 'iv-m8t3h6ng')!.seat).toBe('lead');
  });

  it('a scored interview the viewer sat on without a scorecard of their own is still due for them', () => {
    const i = world.interviews.find((x) => x.id === 'iv-j6x2d9sb')!;
    expect(bucketFor({ ...i, panelIds: ['u-wen'] }, { id: 'u-wen', role: 'interviewer' }, world.scorecards)).toBe('scorecard-due');
    expect(bucketFor(i, { id: 'u-hugo', role: 'interviewer' }, world.scorecards)).toBe('done');
  });

  it('the hiring manager\'s openings: candidates by stage and the pipeline, without the opening that is not theirs', () => {
    const ix = index('u-amara', 'hiring-manager');
    const rows = ix.world.openings.map((o) => ix.openingRow(o));
    expect(rows.map((r) => r.title)).toEqual(['Engineering Manager', 'Senior Backend Engineer']);
    const backend = rows.find((r) => r.id === 'op-backend')!;
    expect(backend.byStage).toEqual({ interviewing: 2, debrief: 1, screening: 1, rejected: 1 });
    expect(backend.candidates).toBe(5);
    expect(backend.hiringManager).toEqual({ id: 'u-amara', name: 'Amara Okafor' });
    expect(backend.pipeline.map((p) => p.candidate.name)).toContain('Ingrid Solberg');
    expect(backend.scorecardsIn).toBe(3);
  });

  it('an interview record carries the chosen questions, the kit\'s competencies and the visible scorecards with names', () => {
    const ix = index('u-hugo', 'interviewer');
    const rec = ix.interviewRecord(ix.world.interviews.find((i) => i.id === 'iv-j6x2d9sb')!)!;
    expect(rec.questionsChosen.map((q) => q.id)).toEqual(['q-be-ratelimit', 'q-be-retry']);
    expect(rec.competencies.map((c) => c.name)).toEqual(['Problem solving', 'Code quality', 'Communication']);
    expect(rec.bank.map((q) => q.id)).toEqual(['q-be-ratelimit', 'q-be-retry', 'q-be-twosum']);
    expect(rec.scorecards).toHaveLength(1);
    expect(rec.scorecards[0]!.ratings.map((r) => r.competency)).toEqual(['Problem solving', 'Code quality', 'Communication']);
  });

  it('the debrief: each round names what it assesses, and the rows are only what the application\'s rounds assess', () => {
    const ix = index('u-greta', 'recruiter');
    const app = debriefView(ix, 'cand-qz63q3a3')!.applications[0]!;
    expect(app.rounds.map((r) => [r.name, r.competencyIds])).toEqual([
      ['Coding', ['problem-solving', 'code-quality', 'communication']], ['Working together', ['communication', 'collaboration']],
    ]);
    expect(app.competencies.map((c) => c.name)).toEqual(['Problem solving', 'Code quality', 'Communication', 'Collaboration']);
  });

  it('the kit as read names every round\'s competencies, a round saved without them included (all of them)', () => {
    const ix = index('u-greta', 'recruiter');
    const backend = ix.world.openings.find((o) => o.id === 'op-backend')!;
    const old = { ...backend, kit: { ...backend.kit, rounds: backend.kit.rounds.map(({ competencyIds: _c, ...r }) => r) } };
    expect(ix.openingRow(old).rounds.map((r) => r.competencyIds)).toEqual(backend.kit.rounds.map(() => backend.kit.competencies.map((c) => c.id)));
    expect(ix.openingRow(backend).rounds[0]!.competencyIds).toEqual(['problem-solving', 'code-quality', 'communication']);
  });

  it('a candidate record lists their applications with the interviews the viewer may read', () => {
    const ix = index('u-wen', 'interviewer');
    const rec = ix.candidateRecord(ix.candidates.get('cand-qz63q3a3')!);
    expect(rec.applications).toHaveLength(1);
    expect(rec.applications[0]!.interviews.map((i) => i.id)).toEqual(['iv-f2b6t5zh']);
    // Wen's own is in, so the profile's rows carry the scorecards of the rounds she can read (her own round only here).
    expect(rec.applications[0]!.interviews[0]!.results.map((r) => r.interviewer.id)).toEqual(['u-wen']);
  });
});
