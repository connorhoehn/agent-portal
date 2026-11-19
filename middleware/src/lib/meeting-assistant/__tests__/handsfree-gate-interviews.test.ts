jest.mock('../../../config.js', () => ({
  config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } },
}));

import { GATE_QUESTION, gateInterviews, policyIdOf } from '../handsfree/gate-interviews.js';
import { HANDSFREE_GATE_SEAMS } from '../handsfree/runtime.js';
import type { HandsfreeFamily } from '../policy.js';

describe('the voice gate interviews seam', () => {
  it('is declared, so the gate runs the interviews-family scenarios', () => {
    expect(HANDSFREE_GATE_SEAMS).toContain('interviews-family');
  });

  it('the candidate is a guest to the policy, everyone else keeps their id', () => {
    expect(policyIdOf('cand')).toBe('guest:cand');
    expect(policyIdOf('hugo')).toBe('hugo');
  });

  it('runs the real interviews family: the panel is routed and gets phrase-tool lines, the candidate gets fixed lines', async () => {
    const g = await gateInterviews({ callId: 'gate-t', candidateMayAsk: false });
    expect(g.call.lobby).toBe('interviews:interview:iv-gate');
    const fam = g.policy.handsfree!(g.call) as HandsfreeFamily;
    expect(await fam.admit('hugo')).toBe('route');
    expect(await fam.admit('cand')).toBe('fixed-lines');
    expect(await fam.admit('stranger')).toBe('deny');
    expect(fam.mayBeHeld!({ text: 'how much time is left' })).toBe(true);
    expect(await fam.heldAnswer!({ askedBy: 'hugo', text: 'how much time is left', admission: 'route' })).toMatch(/minutes/);
    expect(await fam.heldAnswer!({ askedBy: 'hugo', text: 'can you repeat the question', admission: 'route' })).toBe(GATE_QUESTION);
    expect(await fam.heldAnswer!({ askedBy: 'cand', text: 'could you repeat the question again', admission: 'fixed-lines' })).toBe(GATE_QUESTION);
    expect(await fam.heldAnswer!({ askedBy: 'hugo', text: 'what is the capital of france', admission: 'route' })).toBeNull();
    expect(g.policy.acknowledgement!(g.call, 'cand')).toBe('in-call-notice');
  });

  it('the candidate may ask when the lead allows it', async () => {
    const g = await gateInterviews({ callId: 'gate-t2', candidateMayAsk: true });
    expect(await (g.policy.handsfree!(g.call) as HandsfreeFamily).admit('cand')).toBe('route');
  });
});
