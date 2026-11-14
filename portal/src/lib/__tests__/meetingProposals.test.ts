import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantMessage } from '../assistantMessages.ts';
import {
  consentLabel, deckQueue, keptKey, needsLine, outcomeLine, parseProposals, personChips, proposalCountWords, stateLine, type ProposalView,
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

test('done and failed read the result and the reason when given; a link only to a portal path', () => {
  assert.equal(stateLine(one({ state: 'done', result: { title: 'Cutover order', href: '/decisions/d1' } })), 'Recorded · Cutover order');
  assert.equal(one({ state: 'done', result: { title: 'x', href: 'https://elsewhere.example' } }).result?.href, null);
  assert.equal(stateLine(one({ state: 'done' })), 'Recorded');
  assert.equal(stateLine(one({ state: 'failed', failure: 'The initiative is archived' })), 'Failed: The initiative is archived');
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
