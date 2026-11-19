// The scorecard at a glance (lib/interviewsMiloAdvice.ts): stars on the kit's 1 to 4 scale, evidence rows that show
// the quote and expand only when there is more, and Milo's recommendation rule, each outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRatings, evidenceRow, isGenericClaim, leadCardIn, miloAdvice, pooledRatings, ratingWords, starsOf } from '../interviewsMiloAdvice.ts';

const REQ = [{ id: 'a', name: 'Ownership' }, { id: 'b', name: 'Clarity' }, { id: 'c', name: 'Testing' }, { id: 'd', name: 'Design' }];
const claim = (seq: number, quote = 'I paged the on-call lead.') => ({ text: 'The candidate said this in answer to the question.', source: { kind: 'transcript' as const, seq, quote } });
const recapFor = (ids: string[]) => ({ state: 'ready' as const, competencies: REQ.map((c) => ({ id: c.id, name: c.name, evidence: ids.includes(c.id) ? [claim(1)] : [] })) });
const all = recapFor(['a', 'b', 'c', 'd']);
const r = (a: number, b: number, c: number, d: number) => ({ a: [a], b: [b], c: [c], d: [d] });

test('stars and words on the 1 to 4 scale', () => {
  assert.equal(starsOf(3), '★★★☆');
  assert.equal(starsOf(1), '★☆☆☆');
  assert.equal(starsOf(9), '★★★★');
  assert.equal(starsOf(3.5), '★★★★');
  assert.equal(ratingWords(3), '3 of 4');
  assert.equal(ratingWords(3.25), '3.3 of 4');
});

test('Advance: high ratings, nothing under the bar, evidence for every competency', () => {
  const a = miloAdvice({ required: REQ, ratings: r(4, 3, 3, 4), recap: all, leadIn: true });
  assert.equal(a.outcome, 'advance');
  assert.equal(a.label, 'Advance');
  assert.equal(a.tone, 'success');
  assert.deepEqual(a.reasons, ['Rated 3.5 of 4 on average across 4 competencies.', 'Strongest on Ownership (4 of 4), with evidence for every competency.']);
});

test('Hold: high ratings but a competency without evidence', () => {
  const a = miloAdvice({ required: REQ, ratings: r(4, 3, 3, 4), recap: recapFor(['a', 'b', 'c']), leadIn: true });
  assert.equal(a.outcome, 'hold');
  assert.equal(a.tone, 'warning');
  assert.equal(a.reasons[0], 'No evidence in the transcript for Design.');
  assert.equal(a.reasons.length, 2);
});

test('Hold: middling ratings, or one competency under the bar', () => {
  assert.equal(miloAdvice({ required: REQ, ratings: r(3, 2, 3, 2), recap: all, leadIn: true }).outcome, 'hold');
  const one = miloAdvice({ required: REQ, ratings: r(4, 1, 4, 4), recap: all, leadIn: true });
  assert.equal(one.outcome, 'hold');
  assert.equal(one.reasons[0], 'Below the bar on Clarity.');
});

test("Don't advance: a low average, or two competencies under the bar", () => {
  const low = miloAdvice({ required: REQ, ratings: r(2, 2, 2, 2), recap: all, leadIn: true });
  assert.equal(low.outcome, 'dont-advance');
  assert.equal(low.label, 'Don\'t advance');
  assert.equal(low.tone, 'error');
  assert.deepEqual(low.reasons, ['Rated 2 of 4 on average across 4 competencies.']);
  const two = miloAdvice({ required: REQ, ratings: r(1, 1, 4, 4), recap: all, leadIn: true });
  assert.equal(two.outcome, 'dont-advance');
  assert.equal(two.reasons[0], 'Below the bar on Ownership and Clarity.');
});

test('not enough evidence: no recap, an unrated competency, or evidence for under half', () => {
  const none = miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: null, leadIn: true });
  assert.equal(none.outcome, 'not-enough');
  assert.equal(none.tone, 'info');
  assert.equal(miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: { state: 'no-transcript', competencies: [] }, leadIn: true }).outcome, 'not-enough');
  const unrated = miloAdvice({ required: REQ, ratings: { a: [4], b: [4] }, recap: all, leadIn: true });
  assert.equal(unrated.outcome, 'not-enough');
  assert.equal(unrated.reasons[0], 'Testing and Design are not rated yet.');
  const thin = miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: recapFor(['a']), leadIn: true });
  assert.equal(thin.outcome, 'not-enough');
  assert.equal(thin.reasons[0], 'The transcript has evidence for only 1 of 4 competencies.');
  // Exactly half evidenced is enough to recommend (at most Hold, since two lack evidence).
  assert.equal(miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: recapFor(['a', 'b']), leadIn: true }).outcome, 'hold');
});

test('pooled ratings average across interviewers', () => {
  const pooled = pooledRatings([{ ratings: [{ competencyId: 'a', rating: 4 }] }, { ratings: [{ competencyId: 'a', rating: 1 }, { competencyId: 'b', rating: 3 }] }]);
  assert.deepEqual(pooled, { a: [4, 1], b: [3] });
  assert.deepEqual(draftRatings({ a: 3, b: null }), { a: [3] });
  // Ownership averages 2.5: not under the bar.
  assert.equal(miloAdvice({ required: REQ.slice(0, 2), ratings: pooled, recap: all, leadIn: true }).outcome, 'hold');
});

test('an evidence row is the quote with its line; the generic sentence never shows', () => {
  const row = evidenceRow(claim(7));
  assert.equal(row.quote, 'I paged the on-call lead.');
  assert.equal(row.where, 'Line 7');
  assert.equal(row.context, null);
  assert.equal(row.fullQuote, null);
  assert.equal(row.expandable, false);
  assert.equal(isGenericClaim('The candidate also said this in the same answer.'), true);
  assert.equal(isGenericClaim('Describes splitting the incident work between two people.'), false);
});

test('an evidence row expands only for a cut quote or a statement that adds something', () => {
  const long = 'We had the payments queue backing up on a Friday night, so I paged the on-call lead, split the work between the two of us and wrote the timeline as we went.';
  const cut = evidenceRow(claim(3, long));
  assert.ok(cut.quote.endsWith('…'));
  assert.ok(cut.quote.length <= 111);
  assert.equal(cut.fullQuote, long);
  assert.equal(cut.expandable, true);
  const said = evidenceRow({ text: 'Describes splitting the incident work.', source: { kind: 'transcript', seq: 2, quote: 'Short.' } });
  assert.equal(said.context, 'Describes splitting the incident work.');
  assert.equal(said.expandable, true);
  const same = evidenceRow({ text: 'Short.', source: { kind: 'transcript', seq: 2, quote: 'Short.' } });
  assert.equal(same.expandable, false);
});

test('no recommendation until the lead\'s scorecard is in: a panelist\'s card alone never yields one', () => {
  const panelOnly = miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: all, leadIn: false });
  assert.equal(panelOnly.outcome, 'not-enough');
  assert.equal(panelOnly.reasons[0], 'The lead interviewer\'s scorecard is not in yet.');
  assert.equal(miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: all, leadIn: true }).outcome, 'advance');
});

test('the lead\'s card is in: their submitted card on this round, or their own draft while the lead rates', () => {
  const wen = { interviewer: { id: 'u-wen' } };
  const hugo = { interviewer: { id: 'u-hugo' } };
  assert.equal(leadCardIn({ leadId: 'u-wen', draftingSeat: null, cards: [hugo] }), false);
  assert.equal(leadCardIn({ leadId: 'u-wen', draftingSeat: null, cards: [hugo, wen] }), true);
  // A panelist's draft is not the lead's; the lead's own draft is.
  assert.equal(leadCardIn({ leadId: 'u-wen', draftingSeat: 'panel', cards: [] }), false);
  assert.equal(leadCardIn({ leadId: 'u-wen', draftingSeat: 'panel', cards: [wen] }), true);
  assert.equal(leadCardIn({ leadId: 'u-wen', draftingSeat: 'lead', cards: [] }), true);
});
