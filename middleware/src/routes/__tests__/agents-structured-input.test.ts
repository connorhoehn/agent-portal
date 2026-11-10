// POST /api/agents/:id/invoke — the optional `payload` object reaches the
// runtime as structured input (the assessment drafter reads `mode` and
// `document` at the top of its payload), with the route-owned keys removed.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true }, auth: {} } }));
import { agentStructuredInput } from '../agents.js';

describe('agentStructuredInput', () => {
  it('passes a plain object through', () => {
    expect(agentStructuredInput({ mode: 'suggest-confluence-content', document: { id: 'page:1' } }))
      .toEqual({ mode: 'suggest-confluence-content', document: { id: 'page:1' } });
  });
  it('drops the keys the route owns', () => {
    expect(agentStructuredInput({ mode: 'x', message: 'no', sessionId: 'no', auth: {}, history: [], userId: 'no' })).toEqual({ mode: 'x' });
  });
  it('drops every identity key the agents read, so a caller cannot name a tenant, a role or a signature', () => {
    expect(agentStructuredInput({
      mode: 'x', tenant: 'assessment', authSig: 'v1.x', sub: 'u-2', role: 'admin', actor: 'a', session_id: 's',
      runId: 'r', run_id: 'r', invocationId: 'i', parentInvocationId: 'p', user_id: 'u', runtimeSessionId: 'rs',
      input: { tenant: 'assessment' }, stream: true, prompt: 'p', input_text: 'p',
    })).toEqual({ mode: 'x' });
  });
  it('ignores anything that is not a plain object, and an empty one', () => {
    expect(agentStructuredInput('str')).toBeUndefined();
    expect(agentStructuredInput(['a'])).toBeUndefined();
    expect(agentStructuredInput(null)).toBeUndefined();
    expect(agentStructuredInput({ message: 'only reserved' })).toBeUndefined();
  });
  it('ignores an oversized object', () => {
    expect(agentStructuredInput({ big: 'x'.repeat(70 * 1024) })).toBeUndefined();
  });
});
