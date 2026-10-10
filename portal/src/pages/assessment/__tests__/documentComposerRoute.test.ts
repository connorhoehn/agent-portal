import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDockSend } from '../knowledge/documentComposerRoute.ts';

const probe = (agentEditable = true) => {
  const calls: string[] = [];
  const routes = { agentEditable, agent: () => { calls.push('agent'); return true; }, chat: () => { calls.push('chat'); return true; } };
  return { calls, routes };
};

test('agent mode goes to the drafter only', () => {
  const { calls, routes } = probe();
  assert.equal(routeDockSend('agent', routes), true);
  assert.deepEqual(calls, ['agent']);
});

test('chat mode goes to the conversation only', () => {
  const { calls, routes } = probe();
  assert.equal(routeDockSend('chat', routes), true);
  assert.deepEqual(calls, ['chat']);
});

test('a reader cannot send agent mode; other modes go nowhere', () => {
  const { calls, routes } = probe(false);
  assert.equal(routeDockSend('agent', routes), false);
  assert.equal(routeDockSend('terminal', routes), false);
  assert.deepEqual(calls, []);
});
