// Run with:  cd portal && node --test 'src/pages/iq/__tests__/*.test.ts'
//
// DEFECTS.md #10: the Library rail's "What is deployed" bounced a member —
// its eleven CTAs all point at Studio/Versions/Evals/Rollout, which are
// platform-only routes. This locks the filter to the platform-role set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promptMgmtItemsFor } from '../iqSubNavFormat.ts';

test('member (non-platform role) sees only Library — no prompt-ops, studio, versions, evals or canary', () => {
  const paths = promptMgmtItemsFor(false).map((i) => i.path);
  assert.deepEqual(paths, ['/iq/library']);
  assert.ok(!paths.includes('/iq/prompt-ops'), 'What is deployed must not reach a member');
  assert.ok(!paths.includes('/iq/prompts'), 'Studio must not reach a member');
  assert.ok(!paths.includes('/iq/history'), 'Versions must not reach a member');
  assert.ok(!paths.includes('/iq/evaluations'), 'Evals must not reach a member');
  assert.ok(!paths.includes('/iq/canary'), 'Rollout/canary must not reach a member');
});

test('org-leader (platform role) sees every Prompt Management item, including What is deployed', () => {
  const paths = promptMgmtItemsFor(true).map((i) => i.path);
  assert.deepEqual(paths, [
    '/iq/library', '/iq/prompt-ops', '/iq/prompts', '/iq/history', '/iq/evaluations', '/iq/canary',
  ]);
});
