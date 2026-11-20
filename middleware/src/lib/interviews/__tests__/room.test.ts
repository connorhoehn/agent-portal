// The room's rules (lib/interviews/room.ts; row I2.4, contract C5): who may start and end, from which states,
// and what the panel's room view carries (and never: the candidate's contact details or résumé).
import { fixtureRegistry } from '../../../mock/core/index.js';
import { HUGO, WEN, interviewCandidatesFixture, interviewOpeningsFixture, interviewsFixture, interviewApplicationsFixture } from '../../../mock/interviews.js';
import { endMove, roomLobbyName, roomView, startMove } from '../room.js';
import { competenciesOfRound, roundIntro, TECHNICAL_ROUND_INTRO } from '../kit.js';
import type { Interview, InterviewState } from '../types.js';

afterEach(() => fixtureRegistry.resetAll('default'));

const row = (id: string): Interview => structuredClone(interviewsFixture.rows().find((i) => i.id === id)!);
const people = (id: string) => ({ id, name: `Name of ${id}` });
const parts = (i: Interview) => {
  const app = interviewApplicationsFixture.rows().find((a) => a.id === i.applicationId)!;
  return { opening: interviewOpeningsFixture.rows().find((o) => o.id === app.openingId)!, candidate: interviewCandidatesFixture.rows().find((c) => c.id === app.candidateId)! };
};
const at = (state: InterviewState): Pick<Interview, 'leadId' | 'panelIds' | 'state'> => ({ leadId: WEN, panelIds: [HUGO], state });

describe('starting', () => {
  it.each(['accepted', 'ready'] as const)('the lead starts from %s', (state) => {
    expect(startMove(at(state), WEN)).toEqual({ ok: true, write: true });
  });
  it('already live is no change', () => expect(startMove(at('live'), WEN)).toEqual({ ok: true, write: false }));
  it.each(['assigned', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'] as const)('refuses from %s, in a plain sentence', (state) => {
    const out = startMove(at(state), WEN);
    expect(out).toMatchObject({ ok: false, reason: 'state' });
    if (!out.ok) expect(out.message).toMatch(/^This interview .*\.$/);
  });
  it('a panel member cannot start; someone without a seat is not told the round exists', () => {
    expect(startMove(at('ready'), HUGO)).toMatchObject({ ok: false, reason: 'not-lead' });
    expect(startMove(at('ready'), 'u-greta')).toMatchObject({ ok: false, reason: 'no-seat' });
  });
});

describe('ending', () => {
  it('the lead ends a live interview', () => expect(endMove(at('live'), WEN)).toEqual({ ok: true, write: true }));
  it('already ended is no change', () => expect(endMove(at('ended'), WEN)).toEqual({ ok: true, write: false }));
  it.each(['assigned', 'accepted', 'ready', 'scored'] as const)('refuses from %s', (state) => {
    expect(endMove(at(state), WEN)).toMatchObject({ ok: false, reason: 'state' });
  });
  it('a panel member cannot end; someone without a seat is not told the round exists', () => {
    expect(endMove(at('live'), HUGO)).toMatchObject({ ok: false, reason: 'not-lead' });
    expect(endMove(at('live'), 'u-amara')).toMatchObject({ ok: false, reason: 'no-seat' });
  });
});

describe('the room view', () => {
  it('a behavioural round: the seats, the chosen questions with their competency, the kit with its anchors', () => {
    const i = row('iv-n5z9f2cq');
    const { opening, candidate } = parts(i);
    const v = roomView(i, opening, candidate.name, HUGO, people)!;
    expect(v).toMatchObject({ id: i.id, lobbyName: 'interviews:interview:iv-n5z9f2cq', seat: 'panel', state: 'accepted', revision: i.revision,
      round: { id: 'rd-leadership', type: 'behavioural', minutes: 60 }, candidate: { name: candidate.name } });
    expect(v.seats).toEqual([{ person: people(WEN), seat: 'lead' }, { person: people(HUGO), seat: 'panel' }]);
    expect(v.questions.map((q) => q.id)).toEqual(i.questionIds);
    for (const q of v.questions) { expect(q.competency).toBeTruthy(); expect(q.starter).toEqual([]); }
    // The round's own competencies (kit.ts competenciesOfRound), never the kit's others: a leadership round has no system design.
    expect(v.competencies).toEqual(competenciesOfRound(opening.kit, i.roundId));
    expect(v.competencies.map((c) => c.id)).toEqual(['people-leadership', 'delivery', 'influence', 'communication']);
    expect(v.competencies[0]!.anchors[4]).toBeTruthy();
  });

  it('the round carries the line the interviewer reads to the candidate: the default on a technical round, the round\'s own when the kit has one, none on a behavioural round', () => {
    const tech = structuredClone(interviewsFixture.rows().find((x) => x.type === 'technical')!);
    const t = parts(tech);
    const v = roomView(tech, t.opening, t.candidate.name, tech.leadId, people)!;
    expect(v.round.intro).toBe(roundIntro({ type: 'technical', surface: v.round.surface ?? undefined }));
    expect(v.round.surface === 'board' || v.round.intro === TECHNICAL_ROUND_INTRO).toBe(true);
    const own = structuredClone(t.opening);
    own.kit.rounds.find((r) => r.id === tech.roundId)!.intro = 'Say "Hey Milo" for the time.';
    expect(roomView(tech, own, t.candidate.name, tech.leadId, people)!.round.intro).toBe('Say "Hey Milo" for the time.');
    const beh = row('iv-n5z9f2cq');
    const b = parts(beh);
    expect(roomView(beh, b.opening, b.candidate.name, HUGO, people)!.round.intro).toBeNull();
  });

  it('each chosen question names its competency; a behavioural one has no starter code', () => {
    const i = row('iv-g9r1y8lp');
    const { opening, candidate } = parts(i);
    const v = roomView(i, opening, candidate.name, WEN, people)!;
    expect(v.questions.map((q) => q.id)).toEqual(['q-em-struggling', 'q-em-slip']);
    for (const q of v.questions) { expect(q.competency).toBe(opening.kit.competencies.find((k) => k.id === q.competencyId)!.name); expect(q.starter).toEqual([]); }
  });

  it('a technical round carries each question\'s starter code by language', () => {
    const i = row('iv-c3k8w2ma');
    const { opening, candidate } = parts(i);
    const v = roomView(i, opening, candidate.name, WEN, people)!;
    expect(v.seat).toBe('lead');
    expect(v.questions[0]!.starter[0]).toMatchObject({ language: 'swift', code: expect.stringContaining('FeedView') });
  });

  it('nothing about the candidate but their name; nothing at all without a seat', () => {
    const i = row('iv-c3k8w2ma');
    const { opening, candidate } = parts(i);
    const text = JSON.stringify(roomView(i, opening, candidate.name, WEN, people));
    expect(text).not.toContain(candidate.email);
    expect(text).not.toContain(candidate.id);
    expect(roomView(i, opening, candidate.name, HUGO, people)).toBeNull();
    expect(roomLobbyName('iv-x')).toBe('interviews:interview:iv-x');
  });
});
