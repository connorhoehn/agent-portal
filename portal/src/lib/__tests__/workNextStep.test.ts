// The Brief callout says the decision's title once (walk, 10 November: the cutover story's
// "Next step" named "Cutover order for legacy SSO tenants" in the step and again in the block's reason).
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivedNextStep, reasonWithoutTopic } from '../workNextStep.ts';

const TOPIC = 'Cutover order for legacy SSO tenants';
const REASON = `Blocked on "${TOPIC}", escalated to Sienna Garcia. She decides once the second internal rehearsal passes.`;

test('a blocked item: the step names the decision, the detail is the reason without the title', () => {
  const next = derivedNextStep(
    { id: 'wi-1', labels: ['blocked'], blockedReason: REASON, blockedByDecisionId: 'd-1' },
    { decisions: [{ id: 'd-1', topic: TOPIC, status: 'escalated' }] },
  );
  assert.equal(next?.step, `The escalated decision "${TOPIC}" comes first.`);
  assert.equal(next?.detail, 'Escalated to Sienna Garcia. She decides once the second internal rehearsal passes.');
  const callout = `${next?.step} ${next?.detail}`;
  assert.equal(callout.split(TOPIC).length - 1, 1, callout);
});

test('reasonWithoutTopic: unchanged without the title; "that decision" mid-sentence; null when only the title', () => {
  assert.equal(reasonWithoutTopic('Waiting on the vendor quote.', TOPIC), 'Waiting on the vendor quote.');
  assert.equal(reasonWithoutTopic(`Sienna holds "${TOPIC}" until Thursday.`, TOPIC), 'Sienna holds that decision until Thursday.');
  assert.equal(reasonWithoutTopic(`Blocked on "${TOPIC}".`, TOPIC), null);
  assert.equal(reasonWithoutTopic(`Waiting on the decision “${TOPIC}”: legal review first.`, TOPIC), 'Legal review first.');
  assert.equal(reasonWithoutTopic(null, TOPIC), null);
});
