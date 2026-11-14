import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantMessage } from '../assistantMessages.ts';
import {
  consentLabel, deckQueue, keptKey, mayTakeOver, needsLine, outcomeLine, parseProposals, personChips, proposalCountWords, resultHref, stateLine, type ProposalView,
} from '../meetingProposals.ts';

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' }, state: 'open',
  executor: { userId: 'u-priya', name: 'Priya' }, named: [], responses: [], missing: { people: ['u-priya'], more: 1, objectedBy: [] },
  dismissedBy: null, createdAt: 100, you: { userId: 'u-sam', response: null, isExecutor: false, isNamed: false }, ...over,
});
const one = (over: Record<string, unknown> = {}): ProposalView => parseProposals({ proposals: [raw(over)] })[0]!;

test('reads the proposal card kind: id and state only', () => {
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-proposal', proposalId: 'p1', state: 'objected', statement: 'x' }),
    { kind: 'assistant-proposal', proposalId: 'p1', state: 'objected' });
  assert.equal(readAssistantMessage({ assistant: true, kind: 'assistant-proposal', proposalId: 'p1', state: 'maybe' }), null);
});

test('parses the route, oldest first, and drops a malformed one', () => {
  const list = parseProposals({ proposals: [raw({ id: 'b', createdAt: 200 }), raw({ id: 'a', createdAt: 50 }), { id: 'bad' }] });
  assert.deepEqual(list.map((p) => p.id), ['a', 'b']);
});

test('the card lines: outcome, needs, chips and the closing line', () => {
  const p = one({ responses: [{ userId: 'u-lee', name: 'Lee', response: 'object', reason: "I'm out next week", at: 1 }], state: 'objected' });
  assert.equal(outcomeLine(p.outcome, 'Auth Migration'), 'Record as a decision on Auth Migration');
  assert.equal(outcomeLine({ kind: 'tool', name: 'create_work_item' }, null), 'Run create work item');
  assert.equal(needsLine(p), 'Needs: Priya (runs it), one more.');
  assert.deepEqual(personChips(p).map((c) => [c.name, c.state, c.runsIt]), [['Priya', 'waiting', true], ['Lee', 'objected', false]]);
  assert.equal(personChips(p)[1]!.label, "Lee · objected: I'm out next week");
  assert.equal(stateLine(p), "Objected by Lee: I'm out next week");
});

test('the card reads the latest run: whose browser, what was made with a link only to a portal path, or why not', () => {
  const by = { userId: 'u-sam', name: 'Sam' };
  assert.equal(stateLine(one({ state: 'running', run: { by, at: 5, title: null, href: null, note: null } })), "Running in Sam's browser");
  assert.equal(stateLine(one({ state: 'running' })), "Running in Priya's browser");
  const done = one({ state: 'done', run: { by, at: 6, title: 'Cutover order', href: '/iq/decisions/d1', note: null } });
  assert.equal(stateLine(done), 'Recorded · Cutover order');
  assert.equal(resultHref(done), '/iq/decisions/d1');
  assert.equal(resultHref(one({ state: 'done', run: { by, at: 6, title: 'x', href: 'https://elsewhere.example', note: null } })), null);
  assert.equal(resultHref(one({ state: 'done', run: { by, at: 6, title: 'x', href: '//elsewhere.example/x', note: null } })), null);
  assert.equal(resultHref(one({ state: 'running', run: { by, at: 6, title: 'x', href: '/iq/decisions/d1', note: null } })), null);
  assert.equal(stateLine(one({ state: 'done' })), 'Recorded');
  assert.equal(stateLine(one({ state: 'failed', run: { by, at: 7, title: null, href: null, note: 'The initiative is archived' } })), 'Failed: The initiative is archived');
  assert.equal(stateLine(one({ state: 'failed' })), 'Failed');
  const handedBack = one({ state: 'consented', run: { by: { userId: 'u-priya', name: 'Priya' }, at: 8, title: null, href: null, note: 'Priya cannot run this; Sam can, by consenting again to run it.' } });
  assert.equal(stateLine(handedBack), 'Priya cannot run this; Sam can, by consenting again to run it.');
  assert.equal(stateLine(one({ state: 'consented' })), 'Consented, waiting for Priya to run it');
  assert.equal(stateLine(one({ state: 'dismissed', dismissedBy: 'u-sam', dismissedByName: 'Sam' })), 'Marked not a decision by Sam');
  // The old fields are not read.
  assert.equal(stateLine(one({ state: 'done', result: { title: 'old', href: '/x' }, failure: 'old' })), 'Recorded');
});

test('a consenter who is not the executor may take it over; the executor and a non-consenter may not; a new hand-back asks again', () => {
  const sam = { userId: 'u-sam', response: 'consent', isExecutor: false, isNamed: false, canRun: true };
  const p = one({ state: 'consented', you: sam, run: { by: { userId: 'u-priya', name: 'Priya' }, at: 8, title: null, href: null, note: 'gone' } });
  assert.equal(mayTakeOver(p), true);
  assert.equal(mayTakeOver(one({ state: 'consented', you: { ...sam, isExecutor: true } })), false);
  assert.equal(mayTakeOver(one({ state: 'consented', you: { ...sam, canRun: false } })), false);
  const later = one({ state: 'consented', you: sam, run: { by: { userId: 'u-priya', name: 'Priya' }, at: 9, title: null, href: null, note: 'gone again' } });
  assert.notEqual(keptKey(p), keptKey(later));
  assert.deepEqual(deckQueue([later], new Set([keptKey(p)])).map((x) => x.id), ['p1']);
});

test('the deck asks unanswered first, then answered ones until kept; consent says what it does for the executor', () => {
  const ask = one({ id: 'a', createdAt: 2 });
  const answered = one({ id: 'b', createdAt: 1, you: { userId: 'u-sam', response: 'consent', isExecutor: false, isNamed: false } });
  const gone = one({ id: 'c', state: 'dismissed' });
  assert.deepEqual(deckQueue([answered, ask, gone]).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(deckQueue([answered, ask], new Set([keptKey(answered)])).map((p) => p.id), ['a']);
  assert.equal(consentLabel(ask), 'Consent');
  assert.equal(consentLabel({ outcome: ask.outcome, you: { ...ask.you, isExecutor: true } }), 'Consent and record');
  assert.equal(consentLabel({ outcome: { kind: 'tool', name: 'x' }, you: { ...ask.you, isExecutor: true } }), 'Consent and run');
  assert.equal(proposalCountWords(1), '1 proposal');
  assert.equal(proposalCountWords(0), null);
});
