// node --test scripts/journeys/tests/interviews-milo-words.test.mjs — the "Milo never scores" sweep (interviews/h4-kit.mjs
// miloScoresIn) against the scorecard's real recommendation words, built by the portal's own rule
// (portal/src/lib/interviewsMiloAdvice.ts adviceWords). No stack and no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { miloScoresIn } from '../interviews/h4-kit.mjs';
import { adviceWords, miloAdvice } from '../../../portal/src/lib/interviewsMiloAdvice.ts';

const REQ = [{ id: 'a', name: 'Ownership' }, { id: 'b', name: 'Clarity' }, { id: 'c', name: 'Testing' }, { id: 'd', name: 'Design' }];
const claim = { text: 'The candidate said this in answer to the question.', source: { kind: 'transcript', seq: 1, quote: 'I paged the on-call lead.' } };
const recap = (ids) => ({ state: 'ready', competencies: REQ.map((c) => ({ id: c.id, name: c.name, evidence: ids.includes(c.id) ? [claim] : [] })) });
const r = (a, b, c, d) => ({ a: [a], b: [b], c: [c], d: [d] });

// One of each outcome, as the rule gives them.
const shown = {
  advance: miloAdvice({ required: REQ, ratings: r(4, 3, 3, 4), recap: recap(['a', 'b', 'c', 'd']), leadIn: true }),
  inconclusive: miloAdvice({ required: REQ, ratings: r(3, 2, 3, 2), recap: recap(['a', 'b', 'c', 'd']), leadIn: true }),
  'dont-advance': miloAdvice({ required: REQ, ratings: r(1, 1, 4, 4), recap: recap(['a', 'b', 'c', 'd']), leadIn: true }),
  'not-enough': miloAdvice({ required: REQ, ratings: r(4, 4, 4, 4), recap: recap(['a', 'b', 'c', 'd']), leadIn: false }),
};

/** The section's words as a page read gives them: heading, pill and sentence on their own lines, or run together. */
const pageTexts = (advice) => {
  const w = adviceWords(advice);
  const parts = [w.heading, ...(w.pill ? [w.pill.label] : []), w.sentence];
  return [parts.join('\n'), parts.join(' '), parts.join('')];
};

test('each outcome the rule gives is one the sweep expects', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(shown).map(([k, a]) => [k, a.outcome])), { advance: 'advance', inconclusive: 'inconclusive', 'dont-advance': 'dont-advance', 'not-enough': 'not-enough' });
});

test('the scorecard\'s own recommendation words never read as Milo scoring', () => {
  for (const [outcome, advice] of Object.entries(shown)) {
    for (const text of pageTexts(advice)) assert.equal(miloScoresIn(`Scorecard ${text} Ratings`), null, `${outcome}: ${JSON.stringify(text)}`);
  }
});

test('Milo rating, scoring or recommending anything else is still caught', () => {
  assert.ok(miloScoresIn('Milo recommends hiring her.'));
  assert.ok(miloScoresIn('Milo recommends: Advance'));
  assert.ok(miloScoresIn('Milo rated Ownership 4 of 4.'));
  assert.ok(miloScoresIn('Milo\'s rating is 3.'));
  assert.ok(miloScoresIn('Milo\'s recommendation from the ratings and the transcript evidence.'));
});
