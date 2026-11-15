import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssistantMessage } from '../assistantMessages.ts';
import {
  blockedLine, consentLabel, deckQueue, dismissLabel, expiryLine, eyebrowOf, heardText, keptKey, mayTakeOver, needsLine, outcomeLine, parseProposals, personChips,
  proposalCountWords, recordsLine, resultHref, stateLine, waitingCount, waitingOnYou, type ProposalView,
} from '../meetingProposals.ts';

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1', statement: 'Cut over the smallest tenants first', outcome: { kind: 'decision', initiativeId: 'p-auth' }, state: 'open',
  executor: { userId: 'u-priya', name: 'Priya' }, named: [], responses: [], missing: { people: ['u-priya'], more: 1, objectedBy: [] },
  dismissedBy: null, createdAt: 100, you: { userId: 'u-sam', response: null, isExecutor: false, isNamed: false }, source: 'watcher', ...over,
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

test('the card lines: outcome in words, needs with "you", chips, every objector and what clears it', () => {
  const objections = [{ userId: 'u-lee', name: 'Lee', response: 'object', reason: "I'm out next week", at: 1 }, { userId: 'u-bob', name: 'Bob', response: 'object', reason: null, at: 2 }];
  const p = one({ responses: objections, state: 'objected' });
  assert.equal(outcomeLine(p.outcome, 'Auth Migration'), 'Record as a decision on Auth Migration');
  assert.equal(outcomeLine({ kind: 'decision', initiativeId: 'p', summary: 'Record as a decision on Auth' }, null), 'Record as a decision on Auth');
  // A tool outcome is the server's plain sentence, never the tool's name.
  assert.equal(outcomeLine({ kind: 'tool', name: 'create', summary: 'Create a work item titled "Runbook", owned by Lee' }, null), 'Create a work item titled "Runbook", owned by Lee');
  assert.doesNotMatch(outcomeLine({ kind: 'tool', name: 'create_work_item' }, null), /create_work_item|Run create/);
  assert.equal(needsLine(p), 'Needs Priya (runs it) and one more person.');
  assert.equal(needsLine(one({ missing: { people: ['u-sam', 'u-priya'], more: 0, objectedBy: [] } })), 'Needs you and Priya (runs it).');
  assert.equal(needsLine(one({ you: { userId: 'u-priya', response: null, isExecutor: true }, missing: { people: ['u-priya'], more: 1, objectedBy: [] } })), 'Needs you (runs it) and one more person.');
  assert.deepEqual(personChips(p).map((c) => [c.name, c.state, c.runsIt]), [['Priya', 'waiting', true], ['Lee', 'objected', false], ['Bob', 'objected', false]]);
  assert.equal(personChips(p)[1]!.label, "Lee · objected: I'm out next week");
  assert.equal(stateLine(p), "Objected by Lee: I'm out next week; Bob");
  assert.equal(blockedLine(p), 'Blocked until Lee and Bob withdraw their objections, or someone raises it again.');
  assert.equal(blockedLine(one({ responses: objections.slice(1), state: 'objected' })), 'Blocked until Bob withdraws the objection, or someone raises it again.');
  assert.equal(blockedLine(one()), null);
});

test('who raised it, the lines Nova heard, and how a decision will be recorded', () => {
  assert.equal(eyebrowOf(one()), 'Nova heard a decision');
  assert.equal(eyebrowOf(one({ source: 'asked', askedBy: { userId: 'u-dana', name: 'Dana' } })), 'Asked by Dana');
  const heard = one({ heard: [{ speaker: 'Sam', text: "Let's cut over the smallest first" }, { text: 'Agreed' }] });
  assert.deepEqual(heard.heard.map(heardText), ['\u201cLet\'s cut over the smallest first\u201d Sam', '\u201cAgreed\u201d Someone']);
  assert.deepEqual(one().heard, []);
  assert.equal(recordsLine(one({ recordsAs: 'decided' })), 'It will be recorded as decided.');
  assert.equal(recordsLine(one({ recordsAs: 'waiting' })), "It will be recorded as waiting for the initiative owner's decision.");
  assert.equal(recordsLine(one({ recordsAs: 'waiting', state: 'done' })), null);
});

test('the card reads the latest run in plain words: who is running it, what was made and how, or what went wrong', () => {
  const by = { userId: 'u-sam', name: 'Sam' };
  assert.equal(stateLine(one({ state: 'running', run: { by: { userId: 'u-lee', name: 'Lee' }, at: 5, title: null, href: null, note: null } })), 'Lee is running it');
  assert.equal(stateLine(one({ state: 'running', run: { by, at: 5, title: null, href: null, note: null } })), 'You are running it');
  assert.equal(stateLine(one({ state: 'running' })), 'Priya is running it');
  const done = one({ state: 'done', run: { by, at: 6, title: 'Cutover order', href: '/iq/decisions/d1', note: null } });
  assert.equal(stateLine(done), 'Recorded · Cutover order');
  assert.equal(stateLine(one({ state: 'done', recordsAs: 'waiting', run: { by, at: 6, title: 'Cutover order', href: null, note: null } })), "Recorded as waiting for the owner's decision · Cutover order");
  assert.equal(stateLine(one({ state: 'done', recordsAs: 'decided', run: { by, at: 6, title: 'Cutover order', href: null, note: null } })), 'Recorded as decided · Cutover order');
  assert.equal(resultHref(done), '/iq/decisions/d1');
  assert.equal(resultHref(one({ state: 'done', run: { by, at: 6, title: 'x', href: 'https://elsewhere.example', note: null } })), null);
  assert.equal(resultHref(one({ state: 'done', run: { by, at: 6, title: 'x', href: '//elsewhere.example/x', note: null } })), null);
  assert.equal(resultHref(one({ state: 'running', run: { by, at: 6, title: 'x', href: '/iq/decisions/d1', note: null } })), null);
  assert.equal(stateLine(one({ state: 'done' })), 'Recorded');
  assert.equal(stateLine(one({ state: 'failed', run: { by, at: 7, title: null, href: null, note: 'The initiative was deleted or moved since, so nothing was changed.' } })), 'The initiative was deleted or moved since, so nothing was changed.');
  assert.equal(stateLine(one({ state: 'failed' })), 'Nova could not carry this out, so nothing was changed.');
  assert.equal(stateLine(one({ state: 'failed', run: { by, at: 7, title: null, href: null, note: 'It failed.', raisedAs: 'p2' } })), 'It failed. Raised again as a new proposal.');
  const handedBack = one({ state: 'consented', run: { by: { userId: 'u-priya', name: 'Priya' }, at: 8, title: null, href: null, note: 'Priya cannot run this. Sam can run it instead.' } });
  assert.equal(stateLine(handedBack), 'Priya cannot run this. Sam can run it instead.');
  assert.equal(stateLine(one({ state: 'consented' })), 'Everyone needed has consented. Ready for Priya to run it.');
  assert.equal(stateLine(one({ state: 'dismissed', dismissedBy: 'u-lee', dismissedByName: 'Lee' })), 'Marked not a decision by Lee');
  assert.equal(stateLine(one({ state: 'dismissed', dismissedBy: 'u-sam', dismissedByName: 'Sam' })), 'Marked not a decision by you');
  assert.equal(stateLine(one({ state: 'dismissed', source: 'asked', dismissedBy: 'u-lee', dismissedByName: 'Lee' })), 'Dropped by Lee');
  assert.equal(stateLine(one({ state: 'dismissed', dismissedBy: 'u-lee', run: { by, at: 9, title: null, href: null, note: 'x', raisedAs: 'p2' } })), 'Raised again as a new proposal');
  // The old fields are not read.
  assert.equal(stateLine(one({ state: 'done', result: { title: 'old', href: '/x' }, failure: 'old' })), 'Recorded');
});

test('run it now: the executor whenever the server says so; after a hand-back a consenter, or someone who has not answered', () => {
  const sam = { userId: 'u-sam', response: 'consent', isExecutor: false, isNamed: false, canRun: true };
  const p = one({ state: 'consented', you: sam, run: { by: { userId: 'u-priya', name: 'Priya' }, at: 8, title: null, href: null, note: 'gone' } });
  assert.equal(mayTakeOver(p), true);
  assert.equal(waitingOnYou(p), true);
  assert.equal(mayTakeOver(one({ state: 'consented', you: { ...sam, isExecutor: true } })), false);
  assert.equal(waitingOnYou(one({ state: 'consented', you: { ...sam, isExecutor: true } })), true);
  assert.equal(waitingOnYou(one({ state: 'consented', you: { ...sam, canRun: false } })), false);
  assert.equal(waitingOnYou(one({ state: 'consented', you: { ...sam, response: null } })), true);
  const later = one({ state: 'consented', you: sam, run: { by: { userId: 'u-priya', name: 'Priya' }, at: 9, title: null, href: null, note: 'gone again' } });
  assert.notEqual(keptKey(p), keptKey(later));
  assert.deepEqual(deckQueue([later], new Set([keptKey(p)])).map((x) => x.id), ['p1']);
  assert.deepEqual(deckQueue([p], new Set([keptKey(p)])).map((x) => x.id), []);
});

test('the deck asks what waits on you first, then optional ones; answered ones are not asked again; only waiting ones are counted', () => {
  const needed = one({ id: 'a', createdAt: 3, missing: { people: ['u-sam', 'u-priya'], more: 0, objectedBy: [] }, you: { userId: 'u-sam', response: null, isNamed: true } });
  const optional = one({ id: 'b', createdAt: 1 });
  const answered = one({ id: 'c', createdAt: 2, you: { userId: 'u-sam', response: 'consent', isExecutor: false, isNamed: false } });
  const gone = one({ id: 'd', state: 'dismissed' });
  assert.deepEqual(deckQueue([answered, optional, needed, gone]).map((p) => p.id), ['a', 'b']);
  assert.equal(waitingCount(deckQueue([answered, optional, needed, gone])), 1);
  assert.deepEqual(deckQueue([optional, needed], new Set([keptKey(optional)])).map((p) => p.id), ['a']);
  assert.equal(proposalCountWords(1), '1 proposal');
  assert.equal(proposalCountWords(0), null);
});

test("the executor's consent says it runs only when it is the last one needed", () => {
  const exec = { userId: 'u-priya', response: null, isExecutor: true };
  assert.equal(consentLabel(one()), 'Consent');
  // Someone else still needed: the executor's click is not the last, so it only consents.
  assert.equal(consentLabel(one({ you: exec, missing: { people: ['u-priya'], more: 1, objectedBy: [] } })), 'Consent');
  assert.equal(consentLabel(one({ you: exec, missing: { people: ['u-priya', 'u-lee'], more: 0, objectedBy: [] } })), 'Consent');
  assert.equal(consentLabel(one({ you: exec, missing: { people: ['u-priya'], more: 0, objectedBy: [] } })), 'Consent and record');
  assert.equal(consentLabel(one({ you: exec, outcome: { kind: 'tool', name: 'create' }, missing: { people: ['u-priya'], more: 0, objectedBy: [] } })), 'Consent and run');
  assert.equal(consentLabel(one({ you: exec, state: 'objected', missing: { people: ['u-priya'], more: 0, objectedBy: ['u-lee'] } })), 'Consent');
});

test('dismissing reads for what it is, and the expiry shows once the call has ended', () => {
  assert.equal(dismissLabel(one()), 'Not a decision');
  assert.equal(dismissLabel(one({ outcome: { kind: 'tool', name: 'create' } })), 'Not needed');
  assert.equal(dismissLabel(one({ source: 'asked' })), 'Drop it');
  const now = Date.UTC(2026, 10, 14, 12);
  assert.equal(expiryLine(one(), now), null);
  assert.match(expiryLine(one({ expiresAt: now + 3600_000 }), now) ?? '', /^Expires /);
  assert.match(expiryLine(one({ expiresAt: now + 3600_000, missing: { people: ['u-sam'], more: 0, objectedBy: [] } }), now) ?? '', /^Waiting on you · expires /);
  assert.equal(expiryLine(one({ expiresAt: now + 3600_000, state: 'done' }), now), null);
});

test('the proposal card\'s size follows its state and the viewer; each person\'s name carries their answer', async () => {
  const { proposalLayout, personLabel } = await import('../meetingProposals.ts');
  const mine = one({ you: { userId: 'u-priya', response: null, isExecutor: true }, missing: { people: ['u-priya'], more: 1, objectedBy: [] } });
  assert.equal(proposalLayout('open', mine), 'you');
  assert.equal(proposalLayout('open', one()), 'others');
  assert.equal(proposalLayout('open', null), 'others');
  assert.equal(proposalLayout('running', mine), 'others');
  assert.equal(proposalLayout('done', mine), 'done');
  for (const s of ['dismissed', 'expired', 'failed'] as const) assert.equal(proposalLayout(s, mine), 'muted');
  const chips = personChips(one({ responses: [{ userId: 'u-lee', name: 'Lee', response: 'consent', reason: null, at: 1 }] }));
  assert.deepEqual(chips.map(personLabel), ['Priya · waiting · runs it', 'Lee · consented']);
});
