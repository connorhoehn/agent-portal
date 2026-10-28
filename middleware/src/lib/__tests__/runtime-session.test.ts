// scopedRuntimeSessionId: the microVM a conversation runs in is the signed-in
// user's own (row 13, docs/deploy-hardening-goal-2026-10-27.md).

import { RUNTIME_SESSION_ID_MIN_LENGTH, scopedRuntimeSessionId } from '../runtime-session.js';

const CONVO = 'conversation-'.padEnd(40, 'a');

describe('scopedRuntimeSessionId', () => {
  it('is stable for one user and one conversation, so a conversation keeps its microVM', () => {
    expect(scopedRuntimeSessionId('orgiq_u-rhea', CONVO)).toBe(scopedRuntimeSessionId('orgiq_u-rhea', CONVO));
  });

  it('differs per user for the same client-chosen id, and never equals that id', () => {
    const rhea = scopedRuntimeSessionId('orgiq_u-rhea', CONVO);
    const omar = scopedRuntimeSessionId('orgiq_u-omar', CONVO);
    expect(rhea).not.toBe(omar);
    expect(rhea).not.toBe(CONVO);
    expect(scopedRuntimeSessionId(null, CONVO)).not.toBe(rhea);
  });

  it('satisfies the AgentCore >= 33 character rule', () => {
    expect(scopedRuntimeSessionId('orgiq_u-rhea', CONVO).length).toBeGreaterThanOrEqual(RUNTIME_SESSION_ID_MIN_LENGTH);
  });
});
