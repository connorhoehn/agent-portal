// The scorecard's rules (lib/interviews/scorecard.ts; row I5.3) and the hidden-until-yours rule (scope.ts
// othersRevealed, visibleWorld), per role, over the seed world.
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import {
  SCORECARD_LIMITS, changedAfterRecap, checkScorecard, isScoredNow, scorecardCompetencies, latestByAuthor, newScorecardVersion, stateRefusal, submitMove, versionsOf,
} from '../scorecard.js';
import { othersRevealed, visibleWorld } from '../scope.js';
import type { Interview, InterviewsWorld, KitCompetency, Scorecard } from '../types.js';

afterEach(() => fixtureRegistry.resetAll('default'));

const KIT: KitCompetency[] = [
  { id: 'ownership', name: 'Ownership', lookFor: 'Finishes what they start.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } },
  { id: 'clarity', name: 'Clarity', lookFor: 'Says what they mean.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } },
];
const GOOD = {
  ratings: [{ competencyId: 'clarity', rating: 3, note: ' Clear. ' }, { competencyId: 'ownership', rating: 4 }],
  recommendation: 'yes', summary: ' Hire. ', basedOn: 0,
};
const card = (over: Partial<Scorecard>): Scorecard => ({
  id: 'sc-x', interviewId: 'iv-x', interviewerId: 'u-wen', ratings: [], recommendation: 'yes', summary: 's', submittedAt: '2026-11-16T10:00:00.000Z',
  version: 1, changedAfterRecap: false, correctionReason: null, ...over,
});
const iv = (over: Partial<Interview>): Pick<Interview, 'id' | 'leadId' | 'panelIds' | 'state'> => ({ id: 'iv-x', leadId: 'u-wen', panelIds: ['u-hugo'], state: 'ended', ...over });

describe('what a complete scorecard is', () => {
  it('every competency rated 1 to 4, notes trimmed, a recommendation and a summary; ratings come back in the kit\'s order', () => {
    const out = checkScorecard(GOOD, KIT);
    expect(out).toEqual({ ok: true, value: {
      ratings: [{ competencyId: 'ownership', rating: 4, note: '' }, { competencyId: 'clarity', rating: 3, note: 'Clear.' }],
      recommendation: 'yes', summary: 'Hire.', reason: null, basedOn: 0,
    } });
  });

  it.each([
    ['a competency left unrated', { ...GOOD, ratings: [GOOD.ratings[0]] }, 'ratings.ownership', 'Rate Ownership.'],
    ['a rating off the scale', { ...GOOD, ratings: [{ competencyId: 'ownership', rating: 5 }, GOOD.ratings[0]] }, 'ratings.ownership', 'Rate Ownership from 1 to 4.'],
    ['a competency the kit does not have', { ...GOOD, ratings: [...GOOD.ratings, { competencyId: 'charm', rating: 4 }] }, 'ratings', expect.stringContaining('does not judge')],
    ['the same competency twice', { ...GOOD, ratings: [...GOOD.ratings, { competencyId: 'clarity', rating: 2 }] }, 'ratings.clarity', 'Clarity is rated twice.'],
    ['no recommendation', { ...GOOD, recommendation: 'maybe' }, 'recommendation', expect.stringContaining('strong no')],
    ['an empty summary', { ...GOOD, summary: '   ' }, 'summary', 'Write a short summary of your judgement.'],
    ['a summary over the limit', { ...GOOD, summary: 'x'.repeat(SCORECARD_LIMITS.summaryChars + 1) }, 'summary', expect.stringContaining('under')],
    ['a note over the limit', { ...GOOD, ratings: [{ competencyId: 'ownership', rating: 4, note: 'x'.repeat(SCORECARD_LIMITS.noteChars + 1) }, GOOD.ratings[0]] }, 'ratings.ownership.note', expect.stringContaining('under')],
    ['a reason on a first version', { ...GOOD, reason: 'Because.' }, 'reason', expect.stringContaining('only for correcting')],
    ['an author named in the body', { ...GOOD, interviewerId: 'u-hugo' }, 'interviewerId', expect.stringContaining('carries only')],
    ['a recap flag in the body', { ...GOOD, changedAfterRecap: true }, 'changedAfterRecap', expect.stringContaining('carries only')],
  ])('refuses %s', (_label, body, field, message) => {
    const out = checkScorecard(body, KIT);
    expect(out.ok).toBe(false);
    expect(out.ok ? [] : out.fields).toContainEqual({ field, message });
  });

  it('states its limits', () => {
    expect(SCORECARD_LIMITS).toEqual({ noteChars: 2000, summaryChars: 4000, reasonChars: 1000 });
  });
});

describe('a scorecard rates the competencies its round assesses', () => {
  const backend = () => interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!.kit;

  it('a coding round rates problem solving, code quality and communication, never system design', () => {
    const sc = scorecardCompetencies({ roundId: 'rd-coding' }, backend());
    expect(sc.required).toEqual(['problem-solving', 'code-quality', 'communication']);
    expect(sc.competencies.map((c) => c.name)).not.toContain('System design');
    expect(scorecardCompetencies({ roundId: 'rd-design' }, backend()).required).toEqual(['system-design', 'communication']);
    expect(scorecardCompetencies({ roundId: 'rd-together' }, backend()).required).toEqual(['communication', 'collaboration']);
  });

  it('a round saved before rounds named theirs rates every competency of the kit', () => {
    const old = { rounds: [{ id: 'rd-1', name: 'Old', type: 'technical' as const, minutes: 60 }], competencies: KIT };
    expect(scorecardCompetencies({ roundId: 'rd-1' }, old)).toEqual({ competencies: KIT, required: ['ownership', 'clarity'] });
  });

  it('each of the round\'s competencies must be rated, and one it does not assess is refused', () => {
    const kit = { rounds: [{ id: 'rd-1', name: 'One', type: 'behavioural' as const, minutes: 45, competencyIds: ['clarity'] }], competencies: KIT };
    const sc = scorecardCompetencies({ roundId: 'rd-1' }, kit);
    expect(sc).toEqual({ competencies: [KIT[1]], required: ['clarity'] });
    expect(checkScorecard({ ...GOOD, ratings: [{ competencyId: 'clarity', rating: 3 }] }, sc.competencies, sc.required).ok).toBe(true);
    expect(checkScorecard({ ...GOOD, ratings: [] }, sc.competencies, sc.required)).toMatchObject({ ok: false, fields: [{ field: 'ratings.clarity', message: 'Rate Clarity.' }] });
    expect(checkScorecard(GOOD, sc.competencies, sc.required)).toMatchObject({ ok: false, fields: [{ field: 'ratings' }] });
  });

  it('a correction keeps what the author\'s latest version rated outside the round, and never requires it', () => {
    const kit = { rounds: [{ id: 'rd-1', name: 'One', type: 'behavioural' as const, minutes: 45, competencyIds: ['clarity'] }], competencies: KIT };
    const v1 = { version: 1, ratings: [{ competencyId: 'ownership', rating: 3 as const, note: '' }, { competencyId: 'clarity', rating: 3 as const, note: '' }] };
    const sc = scorecardCompetencies({ roundId: 'rd-1' }, kit, [v1]);
    expect(sc).toEqual({ competencies: KIT, required: ['clarity'] });
    expect(checkScorecard({ ...GOOD, basedOn: 1, reason: 'Typo.' }, sc.competencies, sc.required).ok).toBe(true);
  });

  it('every seeded scorecard passes its round\'s check', () => {
    const openings = interviewOpeningsFixture.rows();
    const ivs = interviewsFixture.rows();
    const cards = interviewScorecardsFixture.rows();
    const apps = interviewApplicationsFixture.rows();
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      const i = ivs.find((x) => x.id === c.interviewId)!;
      const kit = openings.find((o) => o.id === apps.find((a) => a.id === i.applicationId)!.openingId)!.kit;
      const body = { ratings: c.ratings, recommendation: c.recommendation, summary: c.summary, basedOn: 0 };
      const sc = scorecardCompetencies(i, kit);
      expect([c.id, checkScorecard(body, sc.competencies, sc.required).ok]).toEqual([c.id, true]);
    }
  });
});

describe('who may submit, and when', () => {
  it('the lead and each panel member, once it has ended; the first version is 1', () => {
    expect(submitMove(iv({}), 'u-wen', [], 0, false)).toEqual({ ok: true, version: 1 });
    expect(submitMove(iv({}), 'u-hugo', [], 0, false)).toEqual({ ok: true, version: 1 });
  });

  it('nobody outside the seats', () => {
    expect(submitMove(iv({}), 'u-greta', [], 0, false)).toMatchObject({ ok: false, reason: 'no-seat' });
  });

  it.each(['assigned', 'accepted', 'ready', 'live', 'reviewed', 'declined', 'cancelled'] as const)('not while it is %s', (state) => {
    expect(submitMove(iv({ state }), 'u-wen', [], 0, false)).toMatchObject({ ok: false, reason: 'state' });
  });

  it('a correction is a new version with a reason, against the latest version, and allowed while scored', () => {
    const mine = [card({ version: 1 })];
    expect(submitMove(iv({ state: 'scored' }), 'u-wen', mine, 1, true)).toEqual({ ok: true, version: 2 });
    expect(submitMove(iv({ state: 'scored' }), 'u-wen', mine, 1, false)).toMatchObject({ ok: false, reason: 'needs-reason' });
    expect(submitMove(iv({}), 'u-wen', mine, 0, false)).toMatchObject({ ok: false, reason: 'stale' });
    expect(submitMove(iv({}), 'u-wen', [...mine, card({ version: 2 })], 1, true)).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('says why in one sentence', () => {
    expect(stateRefusal('live', false)).toBe('You can fill in the scorecard once the interview has ended.');
    expect(stateRefusal('ended', false)).toBeNull();
  });
});

describe('versions', () => {
  const cards = [card({ id: 'a1', version: 1 }), card({ id: 'b1', interviewerId: 'u-hugo' }), card({ id: 'a2', version: 2 })];
  it('keeps every version; the latest per author is what counts', () => {
    expect(versionsOf(cards, 'iv-x', 'u-wen').map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(latestByAuthor(cards).map((s) => s.id)).toEqual(['b1', 'a2']);
  });

  it('a new version is authored by the signed-in person; the reason is kept only on a correction', () => {
    const input = { ratings: [{ competencyId: 'ownership', rating: 4 as const, note: '' }], recommendation: 'yes' as const, summary: 's' };
    const v1 = newScorecardVersion({ id: 'n', interviewId: 'iv-x', authorId: 'u-wen', version: 1, input, reason: 'x', at: 'T', ratingsAtRecap: null });
    expect(v1).toMatchObject({ interviewerId: 'u-wen', version: 1, correctionReason: null, changedAfterRecap: false });
    expect(newScorecardVersion({ id: 'n', interviewId: 'iv-x', authorId: 'u-wen', version: 2, input, reason: 'Misread a note.', at: 'T', ratingsAtRecap: null }).correctionReason).toBe('Misread a note.');
  });

  it('changedAfterRecap stays false while no recap was opened; it compares ratings once round 5 records them', () => {
    const r = [{ competencyId: 'ownership', rating: 3 as const, note: '' }];
    expect(changedAfterRecap(null, r)).toBe(false);
    expect(changedAfterRecap([{ ...r[0]!, rating: 2 }], r)).toBe(true);
    expect(changedAfterRecap(r, r)).toBe(false);
  });
});

describe('scored', () => {
  it('only from ended, once every seated person\'s is in', () => {
    expect(isScoredNow(iv({}), [card({})])).toBe(false);
    expect(isScoredNow(iv({}), [card({}), card({ interviewerId: 'u-hugo' })])).toBe(true);
    expect(isScoredNow(iv({ state: 'scored' }), [card({}), card({ interviewerId: 'u-hugo' })])).toBe(false);
  });
});

describe('others hidden until yours is in (scope.ts)', () => {
  // Nadia's leadership round: Wen leads, Hugo on the panel; ended here. Hugo also leads Nadia's design round.
  function world(cards: Scorecard[], designState: Interview['state'] = 'cancelled'): InterviewsWorld {
    const interviews = interviewsFixture.rows().map((i) => (i.id === 'iv-n5z9f2cq' ? { ...i, state: 'ended' as const }
      : i.id === 'iv-m8t3h6ng' ? { ...i, state: designState } : i));
    return { openings: interviewOpeningsFixture.rows(), candidates: [], applications: [{ id: 'app-efd7rc6g', candidateId: 'cand-xbmv4nvd', openingId: 'op-em', stage: 'interviewing', appliedAt: 'T', history: [] }],
      interviews, scorecards: [...interviewScorecardsFixture.rows(), ...cards] };
  }
  const wens = card({ id: 'sc-w', interviewId: 'iv-n5z9f2cq', interviewerId: 'u-wen' });
  const hugos = card({ id: 'sc-h', interviewId: 'iv-n5z9f2cq', interviewerId: 'u-hugo' });
  const nadiaCards = (w: InterviewsWorld, id: string, role: string) => visibleWorld(w, { id, role }).scorecards.filter((s) => s.interviewId.startsWith('iv-m8t3h6ng') || s.interviewId.startsWith('iv-n5z9f2cq')).map((s) => s.id);

  it('a panel member reads none of the others\' before their own is in, and all of them after', () => {
    expect(othersRevealed(world([wens]), 'u-hugo', 'app-efd7rc6g')).toBe(false);
    expect(nadiaCards(world([wens]), 'u-hugo', 'interviewer')).toEqual([]);
    expect(othersRevealed(world([wens, hugos]), 'u-hugo', 'app-efd7rc6g')).toBe(true);
    expect(nadiaCards(world([wens, hugos]), 'u-hugo', 'interviewer')).toEqual(['sc-w', 'sc-h']);
  });

  it('the lead likewise: their own only, until it is in', () => {
    expect(nadiaCards(world([hugos]), 'u-wen', 'interviewer')).toEqual([]);
    expect(nadiaCards(world([hugos, wens]), 'u-wen', 'interviewer')).toEqual(['sc-h', 'sc-w']);
  });

  it('a round still to run on the same candidate keeps the others hidden until that one is in too', () => {
    expect(othersRevealed(world([wens, hugos], 'accepted'), 'u-hugo', 'app-efd7rc6g')).toBe(false);
    expect(nadiaCards(world([wens, hugos], 'accepted'), 'u-hugo', 'interviewer')).toEqual(['sc-h']);
  });

  it('the recruiter, the opening\'s hiring manager and the admin read submissions as they arrive', () => {
    for (const [id, role] of [['u-greta', 'recruiter'], ['u-amara', 'hiring-manager'], ['u-operator', 'admin']] as const) {
      expect(nadiaCards(world([wens]), id, role)).toEqual(['sc-w']);
    }
  });

  it('another opening\'s hiring manager, and an interviewer of another candidate\'s round, read none', () => {
    expect(nadiaCards(world([wens, hugos]), 'u-someone-else', 'hiring-manager')).toEqual([]);
    expect(othersRevealed(world([wens, hugos]), 'u-third', 'app-efd7rc6g')).toBe(false);
    expect(nadiaCards(world([wens, hugos]), 'u-third', 'interviewer')).toEqual([]);
  });
});
