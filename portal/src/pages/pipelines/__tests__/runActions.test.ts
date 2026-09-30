import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalRun } from '../runActions.ts';

test('isTerminalRun: the four finished statuses — nothing left for Cancel', () => {
  for (const s of ['completed', 'rejected', 'failed', 'cancelled']) assert.equal(isTerminalRun(s), true, s);
  for (const s of ['pending', 'running', 'awaiting_approval', 'paused_at_breakpoint', 'stuck']) assert.equal(isTerminalRun(s), false, s);
});
