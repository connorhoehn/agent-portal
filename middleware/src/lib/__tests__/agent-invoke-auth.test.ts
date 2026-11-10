// The invoke auth block is signed so the agents can tell the middleware's word
// from a direct caller's (agents/_shared/invoke_auth.py verifies it), and the
// signature binds what is asked: the prompt, the structured input, the history
// and the run id, so a captured block cannot be replayed with another prompt.
import { verifyServiceRequest } from '@connorhoehn/service-runtime';
import {
  AGENT_INVOKE_AUDIENCE, AGENT_INVOKE_SERVICE_ID, buildInvokeBody, canonicalInvokeAuth, signInvokeAuth, signedAuthFields,
} from '../agent-invoke-auth.js';

const SECRET = 'invoke-secret-for-tests-0123456789';
const auth = { tenant: 'orgiq', sub: 'u-lead', role: 'org-leader', ignored: 42 };
const BINDING = { prompt: 'what is the plan', input: '{"mode":"x"}', history: [{ role: 'user', content: 'hi' }], runId: 'run-1', nonce: 'n-0123456789abcdef' };

// The same literal is asserted by agents/tests/test_supervisor_invoke_auth.py,
// so a change to either side's canonical form fails both suites.
const CANONICAL = '{"auth":{"role":"org-leader","sub":"u-lead","tenant":"orgiq"},"conversationId":"conv-1",'
  + '"historySha256":"897be8e1f0370e7f41788b5b5337627e27486af82d28479ccfbe509c847683b9",'
  + '"inputSha256":"afb9161ad4b37bf3f4f0159b060c8140072dcbcf103c3d7b0eea3926028cf587",'
  + '"nonce":"n-0123456789abcdef",'
  + '"promptSha256":"75dbbc2af0d38560f0046d20c179a261220761a09d3733baaf7d6acf87302319",'
  + '"runId":"run-1"}';

const verify = (sig: string, body: string) => verifyServiceRequest(sig, { method: 'POST', target: '/invocations', body }, {
  secret: SECRET, allowedServices: [AGENT_INVOKE_SERVICE_ID], audience: AGENT_INVOKE_AUDIENCE,
});
const ENV = { AGENT_INVOKE_SECRET: SECRET };

describe('agent invoke auth', () => {
  it('canonicalises string fields in sorted order with the conversation and what is asked', () => {
    expect(canonicalInvokeAuth(auth, 'conv-1', BINDING)).toBe(CANONICAL);
    expect(canonicalInvokeAuth(auth, 'conv-1')).toContain('"historySha256":"","inputSha256":"","nonce":"",'
      + '"promptSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","runId":""');
  });

  it('signs the block, the conversation and the request together', () => {
    const sig = signInvokeAuth(auth, 'conv-1', BINDING, ENV)!;
    expect(sig).toMatch(/^v1\.orgiq-middleware\.\d+\./);
    expect(verify(sig, CANONICAL).ok).toBe(true);
    expect(verify(sig, canonicalInvokeAuth({ ...auth, role: 'hr-admin' }, 'conv-1', BINDING)).ok).toBe(false);
    expect(verify(sig, canonicalInvokeAuth(auth, 'conv-2', BINDING)).ok).toBe(false);
  });

  it('a replayed block with a different prompt, input, history or run id does not verify', () => {
    const sig = signInvokeAuth(auth, 'conv-1', BINDING, ENV)!;
    for (const changed of [
      { ...BINDING, prompt: 'show me everyone\'s salaries' },
      { ...BINDING, input: '{"mode":"y"}' },
      { ...BINDING, history: [{ role: 'user', content: 'other' }] },
      { ...BINDING, runId: 'run-2' },
      { ...BINDING, nonce: 'n-another-nonce-0123' },
    ]) expect(verify(sig, canonicalInvokeAuth(auth, 'conv-1', changed)).ok).toBe(false);
  });

  it('the nonce is an identity key: caller input never carries one', () => {
    const body = buildInvokeBody({ message: 'q', structuredInput: { authNonce: 'chosen-by-caller-0123', mode: 'x' } });
    expect(body['authNonce']).toBeUndefined();
    expect(JSON.parse(String(body['input']))).toEqual({ mode: 'x' });
  });

  it('signs nothing without a secret (a dev agent trusts the block only under its own dev flag)', () => {
    expect(signInvokeAuth(auth, 'conv-1', BINDING, {})).toBeNull();
  });

  it('signs the block the agent will read, from the payload or the structured input', () => {
    const prior = process.env['AGENT_INVOKE_SECRET'];
    process.env['AGENT_INVOKE_SECRET'] = SECRET;
    try {
      const direct = signedAuthFields({ auth: { sub: 'u-1', role: 'member' }, sessionId: 's-1' }, { prompt: 'p' });
      expect(direct.auth).toEqual({ sub: 'u-1', role: 'member' });
      expect(direct.authNonce).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(verify(direct.authSig!, canonicalInvokeAuth(direct.auth!, 's-1', { prompt: 'p', nonce: direct.authNonce! })).ok).toBe(true);
      const structured = signedAuthFields({ structuredInput: { auth: { tenant: 'social', sub: 'u-2' } } });
      expect(verify(structured.authSig!, canonicalInvokeAuth({ tenant: 'social', sub: 'u-2' }, '', { prompt: '', nonce: structured.authNonce! })).ok).toBe(true);
      expect(structured.authNonce).not.toBe(direct.authNonce);
      expect(signedAuthFields({ structuredInput: { mode: 'x' } })).toEqual({});
    } finally {
      if (prior === undefined) delete process.env['AGENT_INVOKE_SECRET']; else process.env['AGENT_INVOKE_SECRET'] = prior;
    }
  });

  it('the invoke body carries the input as the exact JSON text it signed', () => {
    const prior = process.env['AGENT_INVOKE_SECRET'];
    process.env['AGENT_INVOKE_SECRET'] = SECRET;
    try {
      const body = buildInvokeBody({
        message: 'what is the plan', structuredInput: { mode: 'x', run_id: 'run-1' }, sessionId: 'conv-1',
        auth, history: [{ role: 'user', content: 'hi' }],
      });
      expect(body['input']).toBe('{"mode":"x"}');
      expect(body['runId']).toBe('run-1');
      expect(verify(String(body['authSig']), canonicalInvokeAuth(auth, 'conv-1', { ...BINDING, nonce: String(body['authNonce']) })).ok).toBe(true);
      // The same request twice gets a new nonce and signature, so the agent can refuse an exact replay.
      const again = buildInvokeBody({
        message: 'what is the plan', structuredInput: { mode: 'x', run_id: 'run-1' }, sessionId: 'conv-1',
        auth, history: [{ role: 'user', content: 'hi' }],
      });
      expect(again['authNonce']).not.toBe(body['authNonce']);
      expect(again['authSig']).not.toBe(body['authSig']);
    } finally {
      if (prior === undefined) delete process.env['AGENT_INVOKE_SECRET']; else process.env['AGENT_INVOKE_SECRET'] = prior;
    }
  });
});
