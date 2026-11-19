// The scorecard's form model on the portal side (lib/interviewsScorecard.ts, row I5.3): when it is complete, what is
// hidden, what the submit carries, and the draft kept in this browser only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORECARD_STEPS, SCORECARD_STEP_LABELS, recommendationVerdict, allRated, bodyOf, clearDraft, draftFrom, emptyDraft, evidenceFor, hasScorecard, loadDraft, missingFrom, recapSourceOf, roundCompetencies, nextStep, openBodyOf, othersLine,
  previousStep, recapAskOutcome, recapAskPath, recapStateLine, recapUrl, reviewedLine, saveDraft, scaleOf, scorecardPath,
  type DraftStore, type ScorecardView,
} from '../interviewsScorecard.ts';

const KIT = [
  { id: 'ownership', name: 'Ownership', lookFor: 'Finishes what they start.', anchors: { 1: 'Does not meet', 2: 'Partly meets', 3: 'Meets', 4: 'Exceeds' } },
  { id: 'clarity', name: 'Clarity', lookFor: 'Says what they mean.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } },
];
const LIMITS = { noteChars: 10, summaryChars: 20, reasonChars: 5 };

test('the scale is the competency\'s anchors, lowest first', () => {
  assert.deepEqual(scaleOf(KIT[0]!), [
    { value: 1, label: 'Does not meet' }, { value: 2, label: 'Partly meets' }, { value: 3, label: 'Meets' }, { value: 4, label: 'Exceeds' },
  ]);
  assert.equal(scorecardPath('iv 1'), '/interviews/rounds/iv%201/scorecard');
});

test('complete only when every competency is rated, a recommendation is chosen and a summary written', () => {
  assert.deepEqual(missingFrom(emptyDraft(), KIT, LIMITS, false), ['Rate Ownership, Clarity.', 'Choose your recommendation.', 'Write a short summary of your judgement.']);
  const d = { ...emptyDraft(), ratings: { ownership: 4 as const, clarity: 2 as const }, recommendation: 'yes' as const, summary: 'Good.' };
  assert.deepEqual(missingFrom(d, KIT, LIMITS, false), []);
  assert.deepEqual(missingFrom({ ...d, notes: { clarity: 'x'.repeat(11) } }, KIT, LIMITS, false), ['Keep the note on Clarity under 10 characters.']);
  assert.deepEqual(missingFrom(d, KIT, LIMITS, true), ['Say why you are correcting your scorecard.']);
  assert.deepEqual(missingFrom({ ...d, reason: 'Too long' }, KIT, LIMITS, true), ['Keep the reason under 5 characters.']);
});

test('the submit carries ratings in the kit\'s order, trimmed notes, never an author; a reason only on a correction', () => {
  const d = { ...emptyDraft(), ratings: { clarity: 2 as const, ownership: 4 as const }, notes: { ownership: ' Saw it. ' }, recommendation: 'no' as const, summary: ' Not yet. ', reason: ' Typo. ' };
  assert.deepEqual(bodyOf(d, KIT, 0, []), {
    ratings: [{ competencyId: 'ownership', rating: 4, note: 'Saw it.' }, { competencyId: 'clarity', rating: 2, note: '' }],
    recommendation: 'no', summary: 'Not yet.', basedOn: 0,
  });
  assert.equal((bodyOf(d, KIT, 2, []) as { reason?: string }).reason, 'Typo.');
  assert.equal('interviewerId' in bodyOf(d, KIT, 2, []), false);
});

test('the submit sends only the red flags the kit still lists: a flag reworded since the last version no longer refuses a correction', () => {
  const d = { ...emptyDraft(), ratings: { ownership: 4 as const }, recommendation: 'yes' as const, summary: 'Fine.', redFlagsSeen: ['Old wording', 'Kept flag'] };
  assert.deepEqual((bodyOf(d, KIT, 1, ['Kept flag', 'New wording']) as { redFlagsSeen?: string[] }).redFlagsSeen, ['Kept flag']);
  assert.equal('redFlagsSeen' in bodyOf({ ...d, redFlagsSeen: ['Old wording'] }, KIT, 1, ['New wording']), false);
});

test('a correction starts from the latest version as submitted', () => {
  const card = { ratings: [{ competencyId: 'ownership', rating: 3, note: 'n', competency: 'Ownership' }], recommendation: 'yes', summary: 's' } as unknown as ScorecardView;
  assert.deepEqual(draftFrom(card), { ratings: { ownership: 3 }, notes: { ownership: 'n' }, recommendation: 'yes', summary: 's', reason: '', step: 'rate', recapOpened: false });
});

test('what the viewer reads of the others: hidden until theirs is in, none yet, or the list', () => {
  const seat = { interview: { seat: 'panel' } } as const;
  assert.match(othersLine({ ...seat, othersHidden: true, others: [] } as never)!, /hidden until yours is in/);
  assert.match(othersLine({ ...seat, othersHidden: false, others: [] } as never)!, /No one else/);
  assert.match(othersLine({ interview: { seat: null }, othersHidden: false, others: [] } as never)!, /No scorecards have been submitted/);
  assert.equal(othersLine({ ...seat, othersHidden: false, others: [{}] } as never), null);
});

test('My interviews opens the scorecard for a seat once the round has ended', () => {
  assert.equal(hasScorecard({ seat: 'lead', state: 'ended' }), true);
  assert.equal(hasScorecard({ seat: 'panel', state: 'scored' }), true);
  assert.equal(hasScorecard({ seat: 'lead', state: 'live' }), false);
  assert.equal(hasScorecard({ seat: null, state: 'ended' }), false);
});

test('the draft is kept per interview and version in this browser, and cleared on submit; a broken store is ignored', () => {
  const m = new Map<string, string>();
  const store: DraftStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
  const d = { ...emptyDraft(), ratings: { ownership: 2 as const }, summary: 'half' };
  saveDraft('iv-1', 0, d, store);
  assert.deepEqual(loadDraft('iv-1', 0, store), d);
  assert.equal(loadDraft('iv-2', 0, store), null);
  assert.equal(loadDraft('iv-1', 1, store), null);
  clearDraft('iv-1', 0, store);
  assert.equal(loadDraft('iv-1', 0, store), null);
  const broken: DraftStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  assert.equal(loadDraft('iv-1', 0, broken), null);
  assert.doesNotThrow(() => saveDraft('iv-1', 0, d, broken));
  assert.doesNotThrow(() => clearDraft('iv-1', 0, broken));
});

const memoryStore = (): DraftStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } };
};

test('rate first, then Milo\'s recap, then the go or no-go (decision 14)', () => {
  assert.deepEqual([...SCORECARD_STEPS], ['rate', 'recap', 'decide']);
  assert.equal(nextStep('rate'), 'recap');
  assert.equal(nextStep('recap'), 'decide');
  assert.equal(nextStep('decide'), 'decide');
  assert.equal(previousStep('decide'), 'recap');
  assert.equal(previousStep('recap'), 'rate');
  assert.equal(previousStep('rate'), 'rate');
  assert.equal(emptyDraft().step, 'rate');
});

test('the recap opens only with every competency rated, and the open carries the ratings and nothing else', () => {
  const d = { ...emptyDraft(), ratings: { ownership: 4 as const }, notes: { ownership: 'private note' }, summary: 'x' };
  assert.equal(allRated(d, KIT), false);
  const all = { ...d, ratings: { ownership: 4 as const, clarity: 2 as const } };
  assert.equal(allRated(all, KIT), true);
  assert.deepEqual(openBodyOf(all, KIT), { ratings: [{ competencyId: 'ownership', rating: 4 }, { competencyId: 'clarity', rating: 2 }] });
});

test('the draft resumes a step past the ratings only when the recap was opened from it', () => {
  const store = memoryStore();
  saveDraft('iv-1', 0, { ...emptyDraft(), step: 'decide', recapOpened: true }, store);
  assert.equal(loadDraft('iv-1', 0, store)?.step, 'decide');
  saveDraft('iv-1', 0, { ...emptyDraft(), step: 'decide', recapOpened: false }, store);
  assert.equal(loadDraft('iv-1', 0, store)?.step, 'rate');
  store.setItem('interviews:scorecard-draft:iv-1:0', JSON.stringify({ step: 'somewhere', recapOpened: true }));
  assert.equal(loadDraft('iv-1', 0, store)?.step, 'rate');
  // A draft saved before the recap step existed reads as at the ratings.
  store.setItem('interviews:scorecard-draft:iv-1:0', JSON.stringify({ summary: 'old' }));
  assert.deepEqual([loadDraft('iv-1', 0, store)?.step, loadDraft('iv-1', 0, store)?.recapOpened], ['rate', false]);
});

test('Milo\'s recap: one sentence when there is nothing to show, and the evidence per competency', () => {
  assert.equal(recapStateLine({ state: 'ready' }), null);
  assert.equal(recapStateLine({ state: 'no-transcript' }), 'Milo has no recap for this round.');
  assert.doesNotMatch(recapStateLine({ state: 'no-transcript' })!, /transcript|consent|declin|chose/i);
  assert.match(recapStateLine({ state: 'paused' })!, /budget/);
  assert.match(recapStateLine({ state: 'none' })!, /could not write/);
  assert.match(recapStateLine({ state: 'none' }, true)!, /no recap for this interview yet/);
  const recap = { competencies: [{ id: 'ownership', name: 'Ownership', evidence: [{ text: 'The candidate said: “I shipped it”', source: { kind: 'transcript' as const, seq: 4, quote: 'I shipped it' } }] }] };
  assert.equal(evidenceFor(recap, 'ownership').length, 1);
  assert.deepEqual(evidenceFor(recap, 'clarity'), []);
  assert.equal(recapUrl('iv 1'), '/api/interviews/interviews/iv%201/recap');
});

test('the recap ask: its path, and what each answer of the server reads as', () => {
  assert.equal(recapAskPath('iv 1'), `${recapUrl('iv 1')}/ask`);
  const body = { answer: null, refused: 'too-soon', line: 'Milo needs a few seconds between questions. Ask again in a moment.', paused: null, retryAfterMs: 20000 };
  assert.deepEqual(recapAskOutcome({ ok: true, status: 200, data: body }), { ok: true, body });
  assert.deepEqual(recapAskOutcome({ ok: false, status: 409, data: body }), { ok: true, body });
  assert.deepEqual(recapAskOutcome({ ok: false, status: 404, data: null, error: 'There is no recap here that you can open.' }), { ok: false, error: 'There is no recap here that you can open.' });
  assert.deepEqual(recapAskOutcome({ ok: false, status: 500, data: null }), { ok: false, error: 'That did not go through. Try again.' });
});

test('a submitted scorecard states its recommendation as a go or no-go in words', () => {
  assert.equal(recommendationVerdict('strong-yes'), 'Go, strong yes');
  assert.equal(recommendationVerdict('yes'), 'Go, yes');
  assert.equal(recommendationVerdict('no'), 'No-go, no');
  assert.equal(recommendationVerdict('strong-no'), 'No-go, strong no');
});

test('the three steps of a scorecard each have a plain label, in the order of the flow', () => {
  assert.deepEqual(SCORECARD_STEPS.map((s) => SCORECARD_STEP_LABELS[s]), ['Rate each competency', "Read Milo's recap", 'Recommend']);
});

test('a reviewed round says why its scorecard has no "Correct it"; any other state, or no scorecard of mine, says nothing', () => {
  assert.equal(reviewedLine('reviewed', true), 'This round has been reviewed, so its scorecards can no longer be corrected.');
  assert.equal(reviewedLine('reviewed', false), null);
  assert.equal(reviewedLine('scored', true), null);
});

test('a round requires only its own competencies; an optional one left unseen is neither missing nor sent (E4 #30)', () => {
  const round = roundCompetencies({ competencies: KIT, required: ['clarity'] });
  assert.deepEqual(round.required.map((c) => c.id), ['clarity']);
  assert.deepEqual(round.optional.map((c) => c.id), ['ownership']);
  const d = { ...emptyDraft(), ratings: { clarity: 3 as const }, notes: { ownership: 'stray' }, recommendation: 'yes' as const, summary: 'Good.' };
  assert.equal(allRated(d, round.required), true);
  assert.deepEqual(missingFrom(d, KIT, LIMITS, false, round.required), []);
  assert.deepEqual(bodyOf(d, KIT, 0, []).ratings, [{ competencyId: 'clarity', rating: 3, note: '' }]);
  assert.deepEqual(openBodyOf(d, KIT), { ratings: [{ competencyId: 'clarity', rating: 3 }] });
});

test('a recap answer\'s source reads the record\'s clock, not the wall clock (E4 #38)', () => {
  assert.deepEqual(recapSourceOf({ seq: 2, speaker: 'Mateo Álvarez', offsetMs: 7_400 }), { label: 'Line 2, Mateo Álvarez', clock: '0:07', seconds: 7 });
  assert.deepEqual(recapSourceOf({ seq: 3, speaker: '' }), { label: 'Line 3', clock: null, seconds: null });
});

test('the red flags seen go with the scorecard when some are ticked, and a correction starts from the ones submitted', () => {
  const d = { ...emptyDraft(), ratings: { ownership: 4 as const, clarity: 2 as const }, recommendation: 'no' as const, summary: 'Not yet.' };
  assert.equal('redFlagsSeen' in bodyOf(d, KIT, 0, []), false);
  assert.equal('redFlagsSeen' in bodyOf({ ...d, redFlagsSeen: [] }, KIT, 0, ['Vague names.']), false);
  assert.deepEqual(bodyOf({ ...d, redFlagsSeen: ['Vague names.'] }, KIT, 0, ['Vague names.'])['redFlagsSeen'], ['Vague names.']);
  const card = { id: 'sc', interviewer: { id: 'u', name: 'U' }, recommendation: 'no' as const, summary: 's', submittedAt: '', version: 1, correctionReason: null, ratings: [], earlier: [], redFlagsSeen: ['Vague names.'] };
  assert.deepEqual(draftFrom(card).redFlagsSeen, ['Vague names.']);
});
