// G57: the decision dialogue. On a waiting decision's record page the docked
// composer becomes a numbered list of the decision's own options, then
// "Something else…" and "Reject", picked with the digit keys (the library's
// ComposerPromptDeck keys, deckKeyAction) or a click; the chosen row asks for
// an optional one-line why and Enter sends; Esc hides the dialogue and gives
// the table commands back. The owner's cases: d-cognito-cutover ("Smallest
// tenants first" / "Riskiest two tenants first") and d-eval-judge-model.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deckKeyAction, pageKeypadTarget, type ComposerPrompt, type ComposerPromptAnswer } from '@connorhoehn/ui-components/social/rich-composer';
import { REJECT, SOMETHING_ELSE, decisionDialogue, dialogueRows, matchDialogueRow, optionBody, optionOutcome } from '../decisionDialogue.ts';
import { decisionPageContext } from '../decisionFormat.ts';
import { CARRY_MS, createKeyCarry } from '../keyCarry.ts';
import { PAGE_OFFER_MAX, pageContextNote } from '../../../lib/voice/pageContext.ts';
import type { DecideBody, DecisionDetail } from '../types';

const CUTOVER: Pick<DecisionDetail, 'id' | 'topic' | 'status' | 'options'> = {
  id: 'd-cognito-cutover', topic: 'Cutover order for legacy SSO tenants', status: 'escalated',
  options: [
    { id: 'smallest-first', label: 'Smallest tenants first', detail: 'Keeps the blast radius low while the team learns the runbook.' },
    { id: 'riskiest-first', label: 'Riskiest two tenants first', detail: 'The custom SAML mappings move while the shim is warm and rollback is a route flip.' },
  ],
};

function recorder(refusal: string | null = null) {
  const sent: DecideBody[] = [];
  return { sent, send: async (body: DecideBody) => { sent.push(body); return refusal; } };
}

type KeyState = { inputEmpty?: boolean; inDeck?: boolean; collapsed?: boolean; canBack?: boolean };
/** What a key does on a card: by default the composer's input is empty and focus is in the dialogue. */
const press = (prompt: ComposerPrompt, k: string, s: KeyState = {}, altKey = false) =>
  deckKeyAction({ key: k, altKey }, {
    prompt, collapsed: s.collapsed ?? false, inputEmpty: s.inputEmpty ?? true, inDeck: s.inDeck ?? true, busy: false, canBack: s.canBack,
  });

const answer = async (prompt: ComposerPrompt, a: ComposerPromptAnswer) => prompt.onAnswer(a);
async function pick(prompt: ComposerPrompt, optionId: string): Promise<ComposerPrompt> {
  const result = await answer(prompt, { kind: 'choice', optionId });
  assert.ok(result && 'next' in result, `picking ${optionId} opens its follow-up`);
  return result.next;
}

test('the rows: the decision\'s own options, numbered, then Something else… and Reject as the last numbered rows', () => {
  const rows = dialogueRows(CUTOVER.options);
  assert.deepEqual(rows.map((r) => [r.n, r.id, r.label, r.kind]), [
    [1, 'smallest-first', 'Smallest tenants first', 'option'],
    [2, 'riskiest-first', 'Riskiest two tenants first', 'option'],
    [3, SOMETHING_ELSE, 'Something else…', 'other'],
    [4, REJECT, 'Reject', 'reject'],
  ]);
  assert.deepEqual(dialogueRows([]).map((r) => r.n), [1, 2], 'a decision with no options still offers Something else… and Reject');
  const prompt = decisionDialogue(CUTOVER, true, recorder().send)!;
  assert.equal(prompt.kind, 'choice');
  assert.equal(prompt.title, 'Cutover order for legacy SSO tenants');
  assert.deepEqual(prompt.options!.map((o) => o.label), ['Smallest tenants first', 'Riskiest two tenants first', 'Something else…', 'Reject']);
  assert.equal(prompt.options![0]!.hint, 'Keeps the blast radius low while the team learns the runbook.');
  assert.equal(prompt.options![3]!.emphasis, 'danger');
});

test('no dialogue when the viewer may not decide, or once it is settled: the composer stays the table\'s', () => {
  assert.equal(decisionDialogue(CUTOVER, false, recorder().send), null);
  assert.equal(decisionDialogue({ ...CUTOVER, status: 'resolved' }, true, recorder().send), null);
  assert.equal(decisionDialogue({ ...CUTOVER, status: 'rejected' }, true, recorder().send), null);
  assert.ok(decisionDialogue({ ...CUTOVER, status: 'open' }, true, recorder().send));
});

test('keypad: 2 picks "Riskiest two tenants first"; its why is optional, and Enter on the empty line decides with the option alone', async () => {
  const r = recorder();
  const prompt = decisionDialogue(CUTOVER, true, r.send)!;
  for (const [k, id] of [['1', 'smallest-first'], ['2', 'riskiest-first'], ['3', SOMETHING_ELSE], ['4', REJECT]] as const) {
    assert.deepEqual(press(prompt, k), { type: 'pick', optionId: id }, `key ${k}`);
  }
  assert.equal(press(prompt, '5'), null, 'no fifth row');
  assert.deepEqual(press(prompt, '2', { inDeck: false, inputEmpty: true }), { type: 'pick', optionId: 'riskiest-first' }, 'from the composer input too');
  const why = await pick(prompt, 'riskiest-first');
  assert.equal(why.kind, 'text');
  assert.equal(why.title, '2. Riskiest two tenants first');
  assert.match(why.question, /optional/i);
  assert.equal(r.sent.length, 0, 'picking a row sends nothing yet');
  // Enter on the empty why line: the deck takes the default, "Decide without a reason".
  assert.deepEqual(press(why, 'Enter', { inDeck: false }), { type: 'default', optionId: 'decide-now' });
  assert.deepEqual(await answer(why, { kind: 'option', optionId: 'decide-now' }), { receipt: 'Decided: Riskiest two tenants first' });
  assert.deepEqual(r.sent, [{ optionId: 'riskiest-first', outcome: 'resolved' }]);
});

test('keys typed in the same tick as the pick, before the reason field has the focus, are not lost (journey M2)', async () => {
  // Enter alone: held by the page, pressed in the field once it has the focus, where the empty line decides.
  const r = recorder();
  const carry = createKeyCarry();
  const prompt = decisionDialogue(CUTOVER, true, r.send, carry)!;
  const picked = answer(prompt, { kind: 'choice', optionId: 'riskiest-first' });
  assert.equal(carry.key({ key: 'Enter' }), 'held', 'the Enter fired with the pick is held, not dropped');
  const why = await picked;
  assert.ok(why && 'next' in why);
  const landed = carry.land();
  assert.deepEqual(landed, { text: '', submit: true });
  assert.equal(carry.armed, false, 'landing ends the carry');
  // In the field: Enter on the empty line takes the default, "Decide without a reason".
  assert.deepEqual(press(why.next, 'Enter', { inDeck: false, inputEmpty: landed!.text === '' }), { type: 'default', optionId: 'decide-now' });
  await answer(why.next, { kind: 'option', optionId: 'decide-now' });
  assert.deepEqual(r.sent, [{ optionId: 'riskiest-first', outcome: 'resolved' }]);

  // Digits and letters typed in the gap are the reason (a digit there is text, never another pick), then Enter sends it.
  const r2 = recorder();
  const carry2 = createKeyCarry();
  const prompt2 = decisionDialogue(CUTOVER, true, r2.send, carry2)!;
  const picked2 = answer(prompt2, { kind: 'choice', optionId: 'smallest-first' });
  for (const k of [...'2 teams firsx', 'Backspace', 't', 'Enter']) assert.equal(carry2.key({ key: k }), 'held', `key ${k}`);
  assert.equal(carry2.key({ key: 'x' }), 'pass', 'a key after the held Enter is not part of the answer');
  const why2 = await picked2;
  assert.ok(why2 && 'next' in why2);
  const landed2 = carry2.land()!;
  assert.deepEqual(landed2, { text: '2 teams first', submit: true });
  await answer(why2.next, { kind: 'text', text: landed2.text });
  assert.deepEqual(r2.sent, [{ optionId: 'smallest-first', outcome: 'resolved', rationale: '2 teams first' }]);
});

test('the key carry: idle until a pick, Escape and shortcuts end it, and an unlanded carry expires', () => {
  const carry = createKeyCarry();
  assert.equal(carry.key({ key: 'Enter' }), 'pass', 'idle: the page keeps its keys');
  assert.equal(carry.land(), null);
  carry.arm(1000);
  assert.equal(carry.key({ key: 'Tab' }), 'pass', 'Tab is not the reason\'s');
  assert.equal(carry.key({ key: 'a' }), 'held');
  assert.equal(carry.key({ key: 'k', metaKey: true }), 'pass', 'a shortcut ends it');
  assert.equal(carry.armed, false);
  carry.arm(1000);
  assert.equal(carry.key({ key: 'Escape' }), 'pass');
  assert.equal(carry.armed, false, 'Escape ends it (the dialogue hides)');
  carry.arm(1000);
  assert.equal(carry.expired(1000 + CARRY_MS), false);
  assert.equal(carry.expired(1001 + CARRY_MS), true);
  carry.drop();
  assert.equal(carry.armed, false);
});

test('a why typed on the chosen row rides along as the rationale; a refusal stays on the card', async () => {
  const r = recorder();
  const why = await pick(decisionDialogue(CUTOVER, true, r.send)!, 'smallest-first');
  // On the why line digits are typed words, not picks, and Enter with words is the composer's send (the answer).
  assert.equal(press(why, '1', { inputEmpty: false, inDeck: false }), null);
  assert.equal(press(why, 'Enter', { inputEmpty: false, inDeck: false }), null);
  assert.deepEqual(await answer(why, { kind: 'text', text: '  the team learns the runbook on low-risk tenants ' }),
    { receipt: 'Decided: Smallest tenants first, because the team learns the runbook on low-risk tenants' });
  assert.deepEqual(r.sent, [{ optionId: 'smallest-first', outcome: 'resolved', rationale: 'the team learns the runbook on low-risk tenants' }]);

  const refused = recorder('this decision is already resolved');
  const again = await pick(decisionDialogue(CUTOVER, true, refused.send)!, 'smallest-first');
  assert.deepEqual(await answer(again, { kind: 'option', optionId: 'decide-now' }), { error: 'Not decided: this decision is already resolved' });
  const long = await answer(again, { kind: 'text', text: 'x'.repeat(501) });
  assert.ok(long && 'error' in long && /500/.test(long.error));
});

test('Something else…: what was decided, and why, is the outcome, and is required', async () => {
  const r = recorder();
  const other = await pick(decisionDialogue(CUTOVER, true, r.send)!, SOMETHING_ELSE);
  assert.equal(other.kind, 'text');
  assert.equal(other.options, undefined, 'no way past it without words');
  assert.equal(press(other, 'Enter', { inDeck: false }), null, 'Enter on an empty line picks nothing');
  assert.deepEqual(await answer(other, { kind: 'text', text: '   ' }), { error: 'Say what was decided, and why.' });
  assert.deepEqual(await answer(other, { kind: 'text', text: 'Move the two custom-SAML tenants in a maintenance window first.' }),
    { receipt: 'Decided: Move the two custom-SAML tenants in a maintenance window first.' });
  assert.deepEqual(r.sent, [{ outcome: 'resolved', rationale: 'Move the two custom-SAML tenants in a maintenance window first.' }]);
});

test('Reject: the last numbered row, sent as rejected with why, which it needs', async () => {
  const r = recorder();
  const reject = await pick(decisionDialogue(CUTOVER, true, r.send)!, REJECT);
  assert.equal(reject.title, '4. Reject');
  assert.deepEqual(await answer(reject, { kind: 'text', text: '' }), { error: 'Say why it is rejected.' });
  assert.deepEqual(await answer(reject, { kind: 'text', text: 'Not before the runbook is rehearsed.' }), { receipt: 'Rejected: Not before the runbook is rehearsed.' });
  assert.deepEqual(r.sent, [{ outcome: 'rejected', rationale: 'Not before the runbook is rehearsed.' }]);
});

test('Esc hides the dialogue (the table commands are back); Alt+Backspace on a follow-up returns to the rows', async () => {
  const prompt = decisionDialogue(CUTOVER, true, recorder().send)!;
  assert.deepEqual(press(prompt, 'Escape'), { type: 'collapse' });
  assert.deepEqual(press(prompt, 'Escape', { inDeck: false }), { type: 'collapse' }, 'from the composer input too');
  const why = await pick(prompt, 'riskiest-first');
  assert.deepEqual(press(why, 'Escape', { inDeck: false }), { type: 'collapse' });
  assert.deepEqual(press(why, 'Backspace', { inDeck: false, canBack: true }, true), { type: 'back' });
  // Hidden, the digits are the composer's own again.
  assert.equal(press(prompt, '2', { collapsed: true, inDeck: false }), null);
});

test('the keypad listens on the whole page while the rows are open, never in a field (walk, 9 November)', async () => {
  const prompt = decisionDialogue(CUTOVER, true, recorder().send)!;
  assert.equal(prompt.keypad, 'page', 'the rows take digits from the page body, not only from inside the dialogue');
  // The rule the library applies (ui-components 2.515.2): the body, the record, a link — yes; a field or another dialog — no.
  assert.equal(pageKeypadTarget(null), true);
  assert.equal(pageKeypadTarget({ closest: () => null } as unknown as EventTarget), true, 'plain content or a link');
  assert.equal(pageKeypadTarget({ closest: () => ({}) } as unknown as EventTarget), false, 'an input, textarea, rich-text box or another dialog');
  // The follow-up's why is typed text: it does not ask for page digits.
  const why = await pick(prompt, 'riskiest-first');
  assert.notEqual(why.keypad, 'page');
});

test('the voice names a row by its number or its words, in the same numbering', () => {
  const rows = dialogueRows(CUTOVER.options);
  const id = (said: unknown) => { const hit = matchDialogueRow(rows, said); return 'row' in hit ? hit.row.id : hit.error; };
  assert.equal(id('2'), 'riskiest-first');
  assert.equal(id(2), 'riskiest-first');
  assert.equal(id('option 1'), 'smallest-first');
  assert.equal(id('two'), 'riskiest-first');
  assert.equal(id('Riskiest two tenants first'), 'riskiest-first');
  assert.equal(id('go with the riskiest first'), 'riskiest-first');
  assert.equal(id('smallest first'), 'smallest-first');
  assert.equal(id('something else'), SOMETHING_ELSE);
  assert.equal(id('4'), REJECT);
  assert.equal(id('reject'), REJECT);
  assert.match(id('9'), /1\. Smallest tenants first; 2\. Riskiest two tenants first; 3\. Something else…; 4\. Reject/);
  assert.match(id('tenants'), /Choose one/, 'words both options share name neither');
});

test('the body and the recorded outcome for an option', () => {
  assert.deepEqual(optionBody('nova-pro-10', ''), { body: { optionId: 'nova-pro-10', outcome: 'resolved' } });
  assert.deepEqual(optionBody('nova-pro-10', ' because it agrees with humans '), { body: { optionId: 'nova-pro-10', outcome: 'resolved', rationale: 'because it agrees with humans' } });
  assert.equal(optionOutcome('Nova Pro, sample rate halved to 10%', 'because it agrees with humans'), 'Nova Pro, sample rate halved to 10%, because it agrees with humans');
  assert.equal(optionOutcome('Nova Pro, sample rate halved to 10%', ''), 'Nova Pro, sample rate halved to 10%');
});

test('the page context lists the options as numbered rows for the voice, only to someone who may decide', () => {
  const path = '/iq/decisions/d-cognito-cutover';
  const page = decisionPageContext(CUTOVER, path, true);
  assert.deepEqual(page.choices, ['Smallest tenants first', 'Riskiest two tenants first', 'Something else…', 'Reject']);
  const note = pageContextNote({ tenant: 'orgiq', pathname: path, pageId: 'decisions', page });
  assert.match(note, /option 1\. "Smallest tenants first"/);
  assert.match(note, /option 2\. "Riskiest two tenants first"/);
  assert.match(note, /option 4\. "Reject"/);
  assert.ok((page.offer ?? '').length <= PAGE_OFFER_MAX, 'the offer fits the note without a cut');
  assert.equal(decisionPageContext(CUTOVER, path, false).choices, undefined);
  assert.equal(decisionPageContext({ ...CUTOVER, status: 'resolved' }, path, true).choices, undefined);
});
