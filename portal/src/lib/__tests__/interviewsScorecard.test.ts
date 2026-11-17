// The scorecard's form model on the portal side (lib/interviewsScorecard.ts, row I5.3): when it is complete, what is
// hidden, what the submit carries, and the draft kept in this browser only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORECARD_STEPS, bodyOf, clearDraft, draftFrom, emptyDraft, hasScorecard, loadDraft, missingFrom, othersLine, saveDraft, scaleOf, scorecardPath,
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
  assert.deepEqual(bodyOf(d, KIT, 0), {
    ratings: [{ competencyId: 'ownership', rating: 4, note: 'Saw it.' }, { competencyId: 'clarity', rating: 2, note: '' }],
    recommendation: 'no', summary: 'Not yet.', basedOn: 0,
  });
  assert.equal((bodyOf(d, KIT, 2) as { reason?: string }).reason, 'Typo.');
  assert.equal('interviewerId' in bodyOf(d, KIT, 2), false);
});

test('a correction starts from the latest version as submitted', () => {
  const card = { ratings: [{ competencyId: 'ownership', rating: 3, note: 'n', competency: 'Ownership' }], recommendation: 'yes', summary: 's' } as unknown as ScorecardView;
  assert.deepEqual(draftFrom(card), { ratings: { ownership: 3 }, notes: { ownership: 'n' }, recommendation: 'yes', summary: 's', reason: '' });
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

test('the recap step has one named place, between rating and the recommendation, and is not drawn this round', () => {
  assert.deepEqual([...SCORECARD_STEPS], ['rate', 'decide']);
});
